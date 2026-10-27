import { describeCapabilities, resolveCapabilities, supportedThinkingLevels, modelInfoFromEntry } from "../capabilities.ts";
import { probeModels } from "../gateway-metadata.ts";
import { fetchModelsDevInfoForBaseUrl, localModelCandidates, resolveModelMetadata } from "../model-catalog.ts";
import { readModelState, renameProviderState } from "../model-state.ts";
import { applyMetaChanges, applyModelCapabilities, applyPreferences, diffModelCapabilities as diffStoredModel, effectiveModelInfo, invalidContextPreference } from "../model-settings.ts";
import type { MetaChange } from "../model-settings.ts";
import { apiKeyFromProvider, resolveApiKeyForProbe } from "../api-key.ts";
import { BUILTIN_PROVIDER_IDS, loadModelsConfig, MODELS_JSON_PATH, renameProviderApiKey, saveModelsConfig } from "../config.ts";
import { findModel, modelIdOf } from "../model-entry.ts";
import { AUTO_PROBE_PROFILE } from "../presets.ts";
import { providerIdentity, providerLabel } from "../provider-name.ts";
import { modelDisplayName, modelLabel } from "../model-name.ts";
import type { CommandContext, ModelPreferences, ModelProbeInfo, ModelsConfig, ProbeResult, ProviderApi, SelectItem } from "../types.ts";
import { pickMany, pickTriState, selectOne } from "../ui/select.ts";
import type { TriItem } from "../ui/select.ts";
import {
	promptContextChoice,
	promptManualModels,
	promptMaxTokens,
	promptImageChoice,
	promptSupportedThinkingLevels,
	promptModelName,
	resolveBuiltinCollision,
} from "../ui/prompts.ts";
import { buildProbeUrl, normalizeEndpoint } from "../url.ts";
import {
	addModelEntriesToProvider,
	collectProbedModelInfo,
	describeProvider,
	describeProviderInline,
	fetchGatewayWideInfo,
	fetchModelsDevOptionsForModel,
	mutateModel,
	mutateProvider,
	providerModelItems,
	providerStyleOf,
	refreshModelRegistry,
	removeProvider,
	rememberModelState,
} from "./shared.ts";

export async function editProviderFlow(ctx: CommandContext) {
	let cursor = 0;

	while (true) {
		let config: ModelsConfig;
		try {
			config = loadModelsConfig();
		} catch (error) {
			ctx.ui.notify(`Could not read ${MODELS_JSON_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}

		config.providers ||= {};
		const providerIds = Object.keys(config.providers).sort((a, b) => a.localeCompare(b));
		if (providerIds.length === 0) {
			ctx.ui.notify(`No providers found in ${MODELS_JSON_PATH}`, "warning");
			return;
		}

		const choice = await selectOne(
			ctx,
			"Edit provider",
			providerIds.map((providerId) => {
				const inline = describeProviderInline(providerId, config.providers?.[providerId]);
				return {
					value: providerId,
					label: inline.label,
					suffix: inline.suffix,
					searchText: inline.searchText,
				};
			}),
			{ initialIndex: Math.min(cursor, providerIds.length - 1) },
		);
		if (!choice) return;

		cursor = providerIds.indexOf(choice);
		await editSingleProvider(ctx, choice);
	}
}

// Per-provider action menu. Returns when the user backs out to the provider list.
async function editSingleProvider(ctx: CommandContext, providerId: string) {
	while (true) {
		let config: ModelsConfig;
		try {
			config = loadModelsConfig();
		} catch (error) {
			ctx.ui.notify(`Could not read ${MODELS_JSON_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
		const provider = config.providers?.[providerId];
		if (!provider) {
			ctx.ui.notify(`Provider "${providerId}" no longer exists.`, "warning");
			return;
		}

		const modelCount = Array.isArray(provider.models) ? provider.models.length : 0;
		const action = await selectOne(ctx, `Edit ${providerLabel(providerId, provider)}`, [
			{ value: "probe", label: "Re-probe for models", description: "Query /models again: add new models, flag vanished ones as unsupported, offer metadata updates" },
			{ value: "models", label: "Edit per model", description: `${modelCount} model${modelCount === 1 ? "" : "s"} — reasoning, image input, context, max tokens, headers, delete` },
			{ value: "deletemodels", label: "Delete models", description: "Remove multiple models at once" },
			{ value: "add", label: "Add models manually", description: "Type model ids to add" },
			{ value: "api", label: "API flavor", suffix: ` • ${typeof provider.api === "string" ? provider.api : "unset"}`, description: "Switch between Chat Completions, Responses, Anthropic Messages, and Gemini" },
			{ value: "endpoint", label: "Endpoint", suffix: ` • ${typeof provider.baseUrl === "string" ? provider.baseUrl : "unset"}`, description: "Change the provider's baseUrl" },
			{ value: "rename", label: "Rename provider", description: "Preserve name spelling and derive a lowercase id; case-only changes keep the id" },
			{ value: "delete", label: "Delete provider", description: "Remove this provider from the models config" },
			{ value: "back", label: "Back", description: "Return to the provider list" },
		]);
		if (!action || action === "back") return;

		if (action === "models") {
			await editProviderModels(ctx, providerId);
		} else if (action === "probe") {
			await reprobeProvider(ctx, providerId);
		} else if (action === "deletemodels") {
			await deleteModelsFromProvider(ctx, providerId);
		} else if (action === "add") {
			await addModelsToProvider(ctx, providerId);
		} else if (action === "api") {
			await changeProviderApi(ctx, providerId);
		} else if (action === "endpoint") {
			await changeProviderEndpoint(ctx, providerId);
		} else if (action === "delete") {
			const confirmed = await ctx.ui.confirm("Delete provider?", describeProvider(providerId, provider));
			if (confirmed && (await removeProvider(ctx, providerId))) return; // provider is gone — back to the list
		} else if (action === "rename") {
			// Reassign so the menu keeps editing the same provider under its new name.
			const renamed = await renameProvider(ctx, providerId);
			if (renamed) providerId = renamed;
		}
	}
}

const API_OPTIONS: Array<{ value: ProviderApi; label: string; description: string }> = [
	{ value: "openai-completions", label: "OpenAI Chat Completions", description: 'api: "openai-completions" — most OpenAI-compatible servers' },
	{ value: "openai-responses", label: "OpenAI Responses API", description: 'api: "openai-responses" — the newer /responses endpoint' },
	{ value: "anthropic-messages", label: "Anthropic Messages", description: 'api: "anthropic-messages" — requires an Anthropic-style endpoint' },
	{ value: "google-generative-ai", label: "Gemini (Google generative AI)", description: 'api: "google-generative-ai" — native Gemini format; baseUrl must include the version path (/v1beta)' },
];

// Switch a provider's api flavor in the models config, keeping everything else.
async function changeProviderApi(ctx: CommandContext, providerId: string) {
	let provider: any;
	try {
		provider = loadModelsConfig().providers?.[providerId];
	} catch (error) {
		ctx.ui.notify(`Could not read ${MODELS_JSON_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}
	const current = typeof provider?.api === "string" ? (provider.api as ProviderApi) : undefined;
	const options = API_OPTIONS.map((option) => ({
		value: option.value,
		label: option.label,
		description: option.description,
		suffix: option.value === current ? " • current" : undefined,
	})).sort((a, b) => (a.value === current ? -1 : b.value === current ? 1 : 0));

	const choice = await selectOne(ctx, `API flavor for ${providerId}`, options);
	if (!choice || choice === current) return;

	const saved = await mutateProvider(ctx, providerId, (p) => {
		p.api = choice;
		return true;
	});
	if (saved) ctx.ui.notify(`Changed "${providerId}" to ${choice}.`, "info");
}

// Change a provider's baseUrl, normalized the same way as at add time.
async function changeProviderEndpoint(ctx: CommandContext, providerId: string) {
	let provider: any;
	try {
		provider = loadModelsConfig().providers?.[providerId];
	} catch (error) {
		ctx.ui.notify(`Could not read ${MODELS_JSON_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}
	const current = typeof provider?.baseUrl === "string" ? provider.baseUrl : "";
	const api = typeof provider?.api === "string" ? (provider.api as ProviderApi) : "openai-completions";

	const input = await ctx.ui.input("Endpoint", current || "e.g. https://api.example.com/v1");
	if (input === undefined) return;
	const trimmed = input.trim();
	if (!trimmed || trimmed === current) return;

	let normalized: string;
	try {
		normalized = normalizeEndpoint(trimmed, api);
	} catch (error) {
		ctx.ui.notify(`Invalid endpoint: ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}

	const saved = await mutateProvider(ctx, providerId, (p) => {
		p.baseUrl = normalized;
		return true;
	});
	if (saved) ctx.ui.notify(`Endpoint for "${providerId}" set to ${normalized}.`, "info");
}

// Rename the display name and derived id, preserving config and position.
// Case-only changes leave the id and credentials in place. A selected model
// pinned to a changed provider id must be reselected via /model afterwards.
async function renameProvider(ctx: CommandContext, providerId: string): Promise<string | null> {
	let config: ModelsConfig;
	try {
		config = loadModelsConfig();
	} catch (error) {
		ctx.ui.notify(`Could not read ${MODELS_JSON_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
		return null;
	}
	config.providers ||= {};
	if (!config.providers[providerId]) {
		ctx.ui.notify(`Provider "${providerId}" no longer exists.`, "warning");
		return null;
	}

	const provider = config.providers[providerId];
	const input = await ctx.ui.input("Rename provider", `current: ${providerLabel(providerId, provider)}`);
	if (input === undefined) return null;
	const name = input.trim();
	let { id: newId } = providerIdentity(name);
	if (!newId) return null;

	if (newId !== providerId && config.providers[newId]) {
		ctx.ui.notify(`Provider "${newId}" already exists. Choose a different name.`, "warning");
		return null;
	}

	if (newId !== providerId && BUILTIN_PROVIDER_IDS.has(newId)) {
		const resolved = await resolveBuiltinCollision(ctx, newId);
		if (resolved === null) return null;
		if (resolved !== providerId && config.providers[resolved]) {
			ctx.ui.notify(`Provider "${resolved}" already exists. Choose a different name.`, "warning");
			return null;
		}
		newId = resolved;
	}

	const identity = providerIdentity(name, newId);
	if (newId === providerId && provider.name === identity.name) return null;
	const renamedProvider = { ...provider };
	if (identity.name) renamedProvider.name = identity.name;
	else delete renamedProvider.name;

	// Rebuild key-by-key so the renamed entry keeps its position rather than
	// jumping to the bottom (a naive delete + reassign would reorder it).
	const rebuilt: Record<string, any> = {};
	for (const [key, value] of Object.entries(config.providers)) {
		rebuilt[key === providerId ? newId : key] = key === providerId ? renamedProvider : value;
	}
	config.providers = rebuilt;

	try {
		saveModelsConfig(config);
	} catch (error) {
		ctx.ui.notify(`Could not write ${MODELS_JSON_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
		return null;
	}
	await refreshModelRegistry(ctx);

	// Carry the auth.json entry over to the new id; best-effort, the rename
	// itself already succeeded.
	if (newId !== providerId) {
		try {
			renameProviderApiKey(providerId, newId);
			renameProviderState(providerId, newId);
		} catch (error) {
			ctx.ui.notify(`Renamed, but the auth.json entry could not be moved: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	}

	ctx.ui.notify(`Renamed "${providerLabel(providerId, provider)}" → "${providerLabel(newId, renamedProvider)}".`, "info");
	return newId;
}

// Remove several models at once: multi-select over the provider's models,
// confirm, then filter them out of the config.
async function deleteModelsFromProvider(ctx: CommandContext, providerId: string) {
	let provider: any;
	try {
		provider = loadModelsConfig().providers?.[providerId];
	} catch (error) {
		ctx.ui.notify(`Could not read ${MODELS_JSON_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}
	const modelItems = providerModelItems(provider, providerId);
	if (modelItems.length === 0) {
		ctx.ui.notify(`Provider "${providerId}" has no models.`, "warning");
		return;
	}

	const picked = await pickMany(ctx, `Delete models from ${providerId}`, modelItems);
	if (!picked || picked.length === 0) return;
	const collisionNote = BUILTIN_PROVIDER_IDS.has(providerId)
		? `\nNote: "${providerId}" shares its id with a built-in provider — models that also ship in pi's built-in catalog will still appear in /model after deletion.`
		: "";
	const confirmed = await ctx.ui.confirm(
		"Delete models?",
		`Remove ${picked.length} model${picked.length === 1 ? "" : "s"} from "${providerId}":\n${picked.map((id) => `- ${id}`).join("\n")}${collisionNote}`,
	);
	if (!confirmed) return;

	const removeSet = new Set(picked);
	const saved = await mutateProvider(ctx, providerId, (p) => {
		p.models = (Array.isArray(p.models) ? p.models : []).filter((m: any) => !removeSet.has(modelIdOf(m)));
		return true;
	});
	if (saved) ctx.ui.notify(`Deleted ${picked.length} model${picked.length === 1 ? "" : "s"} from "${providerId}".`, "info");
}

// Pick a model, then a field to edit. Each edit mutates one field in place so
// other fields (headers, overrides, cost) are preserved.
async function editProviderModels(ctx: CommandContext, providerId: string) {
	let cursor = 0;
	while (true) {
		let provider: any;
		try {
			provider = loadModelsConfig().providers?.[providerId];
		} catch (error) {
			ctx.ui.notify(`Could not read ${MODELS_JSON_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
		const modelItems = providerModelItems(provider, providerId);
		if (modelItems.length === 0) {
			ctx.ui.notify(`Provider "${providerId}" has no models.`, "warning");
			return;
		}

		const choice = await selectOne(ctx, `Edit model in ${providerLabel(providerId, provider)}`, modelItems, {
			initialIndex: Math.min(cursor, modelItems.length - 1),
		});
		if (!choice) return;
		cursor = modelItems.findIndex((item) => item.value === choice);

		const deleted = await editSingleModel(ctx, providerId, choice);
		if (deleted) cursor = Math.max(0, cursor - 1);
	}
}

// Field-picker for one model. Returns true if the model was deleted (so the
// caller can adjust its cursor).
async function editSingleModel(ctx: CommandContext, providerId: string, modelId: string): Promise<boolean> {
	while (true) {
		let model: any;
		let metadata: ModelProbeInfo;
		let preferences: ModelPreferences;
		try {
			const provider = loadModelsConfig().providers?.[providerId];
			model = findModel(provider, modelId);
			if (!model) return false;
			const state = readModelState(providerId, modelId);
			metadata = state.metadata ?? await resolveModelMetadata(ctx, modelId, {}, model.api ?? provider.api);
			preferences = { ...state.preferences };
			if (!metadata.name) {
				const reference = await resolveModelMetadata(ctx, modelId, {}, model.api ?? provider.api);
				if (reference.name) metadata = { ...metadata, name: reference.name, sources: { ...metadata.sources, name: reference.sources?.name } };
			}
		} catch (error) {
			ctx.ui.notify(`Could not load model settings: ${error instanceof Error ? error.message : String(error)}`, "error");
			return false;
		}
		const effective = effectiveModelInfo(metadata, preferences);
		const levels = supportedThinkingLevels(effective);
		const field = await selectOne(ctx, `Edit ${modelLabel(modelId, model)}`, [
			{ value: "name", label: "Display name", suffix: ` • ${modelDisplayName(modelId, model)}${Object.hasOwn(preferences, "name") ? " (manual)" : ""}`, description: `API id stays ${modelId}; detected name: ${metadata.name ?? "unknown"} [${metadata.sources?.name ?? "unknown"}]` },
			{ value: "thinking-levels", label: "Supported thinking levels", suffix: ` • ${levels?.join(" / ") ?? "unknown"}`, description: `${preferences.thinkingLevelMap ? "Manual declaration" : effective.sources?.thinkingLevelMap ?? effective.sources?.reasoning ?? "Unknown"} • Auto or edit checkboxes` },
			{ value: "image", label: "Image input", suffix: ` • ${model.input?.includes("image") ? "on" : "off"}${preferences.image !== undefined ? " (manual)" : ""}`, description: `Capability: ${metadata.image === undefined ? "unknown" : metadata.image ? "supported" : "not supported"} [${metadata.sources?.image ?? "unknown"}]` },
			{ value: "context", label: "Context window", suffix: ` • ${model.contextWindow ?? "unset"}${Object.hasOwn(preferences, "contextWindow") ? " (manual)" : ""}`, description: `Detected: ${metadata.contextWindow ?? "unknown"} [${metadata.sources?.contextWindow ?? "unknown"}] • choose a preset or custom limit` },
			{ value: "maxtokens", label: "Max output tokens", suffix: ` • ${model.maxTokens ?? "unset"}${Object.hasOwn(preferences, "maxTokens") ? " (manual)" : ""}`, description: `Detected: ${metadata.maxTokens ?? "unknown"} [${metadata.sources?.maxTokens ?? "unknown"}]` },
			{ value: "override", label: "Headers / endpoint override", suffix: ` • ${model.headers || model.baseUrl || model.api ? "set" : "unset"}`, description: "Per-model HTTP headers and api/baseUrl override" },
			{ value: "refresh", label: "Refresh metadata", description: "Review gateway, models.dev or local capabilities; keep manual limits" },
			{ value: "delete", label: "Delete this model", description: "Remove this model from the provider" },
			{ value: "back", label: "Back", description: "Return to the model list" },
		]);
		if (!field || field === "back") return false;
		if (field === "override") { await editModelOverride(ctx, providerId, modelId); continue; }
		if (field === "refresh") { await refreshModelMetadata(ctx, providerId, modelId); continue; }
		if (field === "delete") {
			const note = BUILTIN_PROVIDER_IDS.has(providerId) ? " Built-in catalog entries remain visible when the provider id is shared." : "";
			if (!(await ctx.ui.confirm("Delete model?", `Remove "${modelId}" from "${providerId}"?${note}`))) continue;
			return await mutateProvider(ctx, providerId, provider => {
				provider.models = (provider.models ?? []).filter((entry: any) => modelIdOf(entry) !== modelId);
				return true;
			});
		}
		const next = typeof model === "string" ? { id: modelId } : structuredClone(model);
		if (field === "thinking-levels") {
			const choice = await promptSupportedThinkingLevels(ctx, metadata, preferences);
			if (!choice) continue;
			if (choice.mode === "auto") delete preferences.thinkingLevelMap;
			else preferences.thinkingLevelMap = choice.map;
			const updated = effectiveModelInfo(metadata, preferences);
			delete next.thinkingLevelMap;
			next.reasoning = updated.reasoning ?? false;
			applyModelCapabilities(next, updated, preferences);
		} else if (field === "name") {
			const choice = await promptModelName(ctx, modelId, modelDisplayName(modelId, model), metadata);
			if (!choice) continue;
			if (choice.mode === "auto") {
				delete preferences.name;
				if (metadata.name && metadata.name !== modelId) next.name = metadata.name;
				else delete next.name;
			} else { preferences.name = choice.value; applyPreferences(next, { name: choice.value }); }
		} else if (field === "image") {
			const choice = await promptImageChoice(ctx, metadata);
			if (!choice) continue;
			if (choice === "auto") { delete preferences.image; next.input = metadata.image ? ["text", "image"] : ["text"]; }
			else { preferences.image = choice === "yes"; next.input = preferences.image ? ["text", "image"] : ["text"]; }
		} else if (field === "context") {
			const choice = await promptContextChoice(ctx, model.contextWindow, metadata);
			if (!choice) continue;
			if (choice.mode === "auto") { delete preferences.contextWindow; if (metadata.contextWindow !== undefined) next.contextWindow = metadata.contextWindow; else delete next.contextWindow; }
			else { preferences.contextWindow = choice.value; if (choice.value === null) delete next.contextWindow; else next.contextWindow = choice.value; }
		} else if (field === "maxtokens") {
			const value = await promptMaxTokens(ctx, model.maxTokens);
			if (value === null) continue;
			preferences.maxTokens = value === 0 ? null : value;
			if (value === 0) delete next.maxTokens; else next.maxTokens = value;
		}
		const saved = await mutateModel(ctx, providerId, modelId, entry => {
			const keys = field === "thinking-levels" ? ["reasoning", "thinkingLevelMap"] : field === "name" ? ["name"] : field === "image" ? ["input"] : field === "context" ? ["contextWindow"] : ["maxTokens"];
			for (const key of keys) {
				if (Object.hasOwn(next, key)) entry[key] = next[key]; else delete entry[key];
			}
		});
		if (saved) rememberModelState(ctx, providerId, modelId, metadata, preferences);
	}
}

async function editModelOverride(ctx: CommandContext, providerId: string, modelId: string) {
	let model: any;
	try {
		model = findModel(loadModelsConfig().providers?.[providerId], modelId);
	} catch {
		model = undefined;
	}
	const currentBase = typeof model?.baseUrl === "string" ? model.baseUrl : "";
	const currentHeaders = model?.headers && typeof model.headers === "object" ? JSON.stringify(model.headers) : "";

	const base = await ctx.ui.input("baseUrl override (blank = use provider, \"-\" to clear)", currentBase || "e.g. https://api.example.com/v1");
	if (base === undefined) return;
	const headers = await ctx.ui.input("Headers as JSON (blank = keep, \"-\" to clear)", currentHeaders || 'e.g. {"x-api-version":"2024-01"}');
	if (headers === undefined) return;

	let parsedHeaders: Record<string, string> | null | undefined;
	const trimmedHeaders = headers.trim();
	if (trimmedHeaders === "-") parsedHeaders = null;
	else if (trimmedHeaders) {
		try {
			const obj = JSON.parse(trimmedHeaders);
			if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("not an object");
			parsedHeaders = obj;
		} catch (error) {
			ctx.ui.notify(`Invalid headers JSON: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
	}

	await mutateModel(ctx, providerId, modelId, (m) => {
		const trimmedBase = base.trim();
		if (trimmedBase === "-") delete m.baseUrl;
		else if (trimmedBase) m.baseUrl = trimmedBase;
		if (parsedHeaders === null) delete m.headers;
		else if (parsedHeaders) m.headers = parsedHeaders;
	});
}

// One-line summary of a stored entry's current config, for the re-probe list.
// Empty string when the entry carries no metadata at all.
function storedModelSummary(model: any): string {
	const details: string[] = [];
	if (model?.reasoning === true) details.push(`thinking:${supportedThinkingLevels(modelInfoFromEntry(model))?.join("/") ?? "unknown"}`);
	if (Array.isArray(model?.input) && model.input.includes("image")) details.push("image");
	if (typeof model?.contextWindow === "number") details.push(`context ${model.contextWindow}`);
	if (typeof model?.maxTokens === "number") details.push(`max-out ${model.maxTokens}`);
	if (model?.cost && typeof model.cost === "object") details.push(`$${model.cost.input}/$${model.cost.output} per 1M`);
	return details.join(" • ");
}

async function reprobeProvider(ctx: CommandContext, providerId: string) {
	let provider: any;
	try {
		provider = loadModelsConfig().providers?.[providerId];
	} catch (error) {
		ctx.ui.notify(`Could not read ${MODELS_JSON_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}
	const api = typeof provider?.api === "string" ? (provider.api as ProviderApi) : "openai-completions";
	if (api !== "openai-completions" && api !== "openai-responses" && api !== "anthropic-messages" && api !== "google-generative-ai") {
		ctx.ui.notify("This provider's API doesn't expose /models. Use 'Add models manually'.", "warning");
		return;
	}
	const baseUrl = typeof provider?.baseUrl === "string" ? provider.baseUrl : "";
	if (!baseUrl) {
		ctx.ui.notify(`Provider "${providerId}" has no baseUrl to probe.`, "error");
		return;
	}

	const apiKey = apiKeyFromProvider(providerId, provider);
	let probed: ProbeResult;
	try {
		ctx.ui.notify(`Probing ${buildProbeUrl(baseUrl)} ...`, "info");
		probed = await probeModels(baseUrl, resolveApiKeyForProbe(apiKey.mode, apiKey.value));
	} catch (error) {
		ctx.ui.notify(`Probe failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}

	const storedModels: any[] = Array.isArray(provider.models) ? provider.models : [];
	const storedIds: string[] = [];
	for (const m of storedModels) {
		const id = modelIdOf(m);
		if (id) storedIds.push(id);
	}
	const storedSet = new Set(storedIds);
	const probedSet = new Set(probed.ids);
	const novelIds = probed.ids.filter((id) => !storedSet.has(id));
	const overlapIds = probed.ids.filter((id) => storedSet.has(id));
	const unsupportedIds = storedIds.filter((id) => !probedSet.has(id));

	const style = providerStyleOf(provider);

	// Gateway-wide metadata (one call per source) — fetch BEFORE any picker so
	// it shows real detected values instead of local-rule guesses. Re-probe
	// always uses the auto profile.
	const profile = AUTO_PROBE_PROFILE;
	let gatewayWide: Map<string, ModelProbeInfo> | undefined;
	if (style !== "ollama") {
		ctx.ui.notify("Fetching model metadata (context, max-out, image/video, reasoning) ...", "info");
		gatewayWide = await fetchGatewayWideInfo(style, apiKey, probed.baseUrl, profile);
		if (gatewayWide.size > 0) {
			for (const [id, info] of gatewayWide) {
				probed.infoById.set(id, { ...(probed.infoById.get(id) ?? {}), ...info });
			}
		}
	}

	// models.dev catalog tier — above the local rules, below detected values.
	const modelsDev = style !== "ollama" && style !== "gemini" ? await fetchModelsDevInfoForBaseUrl(probed.baseUrl) : undefined;

	// Resolve metadata for everything we may touch: new models (to describe and
	// add them) and already-configured ones (to diff against the stored entry).
	const infoById = await collectProbedModelInfo(
		ctx,
		style,
		apiKey,
		probed.baseUrl,
		[...novelIds, ...overlapIds],
		probed.infoById,
		gatewayWide,
		modelsDev,
		api,
	);

	// One tri-state list for everything: [x] keep/add with the latest metadata,
	// [-] keep but don't touch metadata (only for models with changes), [ ]
	// remove/skip. Models needing a decision come first.
	const novelSet = new Set(novelIds);
	const changeById = new Map<string, MetaChange[]>();
	for (const id of overlapIds) {
		const info = infoById.get(id);
		const stored = storedModels.find((m) => modelIdOf(m) === id);
		if (!info || !stored) continue;
		const changes = diffStoredModel(stored, info, readModelState(providerId, id).preferences);
		if (changes.length > 0) changeById.set(id, changes);
	}

	const items: TriItem[] = [];
	for (const [id, changes] of changeById) {
		// Show the incoming changes AND the rest of the stored config, so the
		// unchanged fields stay visible next to the diff.
		const stored = storedModels.find((m) => modelIdOf(m) === id);
		const current = storedModelSummary(stored);
		items.push({
			value: id,
			label: modelLabel(id, stored),
			description: changes.map((c) => c.label).join(" • ") + (current ? ` · current: ${current}` : ""),
			searchText: `${id} updated`,
			states: ["off", "mid", "on"],
			initial: "mid",
		});
	}
	for (const id of novelIds) {
		items.push({
			value: id,
			label: modelLabel(id, infoById.get(id)),
			description: describeCapabilities(infoById.get(id)),
			searchText: `${id} new`,
			states: ["off", "on"],
			initial: "off",
		});
	}
	for (const id of unsupportedIds) {
		// No fresh probe data for these — show the metadata already stored in
		// the config, same as any other configured model, with "unsupported"
		// as a suffix.
		const stored = storedModels.find((m) => modelIdOf(m) === id);
		items.push({
			value: id,
			label: `${modelLabel(id, stored)} • unsupported`,
			description: storedModelSummary(stored) || "no metadata stored",
			searchText: `${id} unsupported`,
			states: ["off", "on"],
			initial: "on",
		});
	}
	for (const id of storedIds) {
		if (changeById.has(id) || !probedSet.has(id)) continue;
		const stored = storedModels.find((m) => modelIdOf(m) === id);
		items.push({ value: id, label: modelLabel(id, stored), description: storedModelSummary(stored) || "no changes", states: ["off", "on"], initial: "on" });
	}

	const picked = await pickTriState(ctx, `Re-probe ${providerId}`, items);
	if (picked === null) return;

	const addIds: string[] = [];
	const removeIds: string[] = [];
	const updateIds: string[] = [];
	for (const item of items) {
		const state = picked.get(item.value) ?? item.initial;
		if (novelSet.has(item.value)) {
			if (state === "on") addIds.push(item.value);
			continue;
		}
		if (state === "off") removeIds.push(item.value);
		else if (state === "on" && changeById.has(item.value)) updateIds.push(item.value);
		// "mid": keep the stored entry unchanged
	}

	const reviewedPreferences = new Map<string, ModelPreferences>();
	for (const id of updateIds) {
		const preferences = await reviewPreferences(ctx, id, infoById.get(id)!, readModelState(providerId, id).preferences ?? {});
		if (preferences !== null) reviewedPreferences.set(id, preferences);
	}
	const acceptedUpdates = updateIds.filter(id => reviewedPreferences.has(id));
	let touched = 0;
	if (removeIds.length > 0 || acceptedUpdates.length > 0) {
		const removeSet = new Set(removeIds);
		const saved = await mutateProvider(ctx, providerId, (p) => {
			let models: any[] = Array.isArray(p.models) ? p.models : [];
			models = models.filter((m) => !removeSet.has(modelIdOf(m)));
			for (const id of acceptedUpdates) {
				const index = models.findIndex((m) => modelIdOf(m) === id);
				if (index === -1) continue;
				// Strings become objects so the new fields have somewhere to live.
				if (typeof models[index] === "string") models[index] = { id, input: ["text", "image"] };
				applyMetaChanges(models[index], infoById.get(id)!, changeById.get(id)!, reviewedPreferences.get(id));
			}
			p.models = models;
			return true;
		});
		if (saved) {
			touched += removeIds.length + acceptedUpdates.length;
			for (const id of acceptedUpdates) rememberModelState(ctx, providerId, id, infoById.get(id)!, reviewedPreferences.get(id));
			const parts: string[] = [];
			if (acceptedUpdates.length > 0) parts.push(`updated metadata for ${acceptedUpdates.length}`);
			if (removeIds.length > 0) parts.push(`removed ${removeIds.length}`);
			ctx.ui.notify(`Re-probe: ${parts.join(", ")} in "${providerId}".`, "info");
		}
	}
	if (addIds.length > 0) {
		touched += addIds.length;
		await addModelEntriesToProvider(ctx, providerId, addIds, infoById);
	}
	for (const id of overlapIds) {
		if (!changeById.has(id) && picked.get(id) === "on") rememberModelState(ctx, providerId, id, infoById.get(id)!);
	}
	if (touched === 0) ctx.ui.notify("No model config changes applied. Unknown fields remain unknown; saved manual limits are kept.", "info");
}

// Validate saved context limits against freshly learned capabilities.
async function reviewPreferences(ctx: CommandContext, modelId: string, info: ModelProbeInfo, saved: ModelPreferences): Promise<ModelPreferences | null> {
	const preferences = { ...saved };
	if (invalidContextPreference(info, preferences)) {
		ctx.ui.notify(`${modelId}: the saved context limit exceeds the gateway's new maximum. Choose a new limit.`, "warning");
		const choice = await promptContextChoice(ctx, preferences.contextWindow ?? undefined, info);
		if (!choice) return null;
		if (choice.mode === "auto") delete preferences.contextWindow;
		else preferences.contextWindow = choice.value;
	}
	return preferences;
}

async function refreshModelMetadata(ctx: CommandContext, providerId: string, modelId: string) {
	try {
		const provider = loadModelsConfig().providers?.[providerId];
		const stored = findModel(provider, modelId);
		if (!provider || !stored) { ctx.ui.notify("The provider or model no longer exists.", "warning"); return; }
		const state = readModelState(providerId, modelId);
		const preferences = state.preferences ?? {};
		const api = stored.api ?? provider.api ?? "openai-completions";
		const style = providerStyleOf({ ...provider, api });
		const base = stored.baseUrl ?? provider.baseUrl;
		const items: SelectItem[] = [
			{ value: "modelsdev", label: "models.dev", description: "Choose a catalog reference; preview all capability changes" },
			{ value: "local", label: "Local Pi model catalog", description: "Choose an installed model reference" },
		];
		if (base) items.push({ value: "endpoint", label: "Gateway + fallback references", description: "Gateway declarations first; fill unknown fields from catalogs and rules" });
		const source = await selectOne(ctx, `Refresh metadata for ${modelId}`, items);
		if (!source) return;
		let resolved: ModelProbeInfo;
		if (source === "modelsdev" || source === "local") {
			const local = localModelCandidates(ctx, modelId, api);
			const candidates = source === "local" ? local : (await fetchModelsDevOptionsForModel(modelId)).map(option => ({ source: "models.dev" as const, label: `models.dev: ${option.providerId}/${option.key}`, info: option.info }));
			if (!candidates.length) { ctx.ui.notify(`${source === "local" ? "The local catalog" : "models.dev"} has no matching model. Capabilities remain unknown where no source provides them.`, "warning"); return; }
			const choices = candidates.map(candidate => resolveCapabilities(modelId, [candidate, ...local]));
			const picked = await selectOne(ctx, `${source === "local" ? "Local" : "models.dev"} entries for ${modelId}`, [
				...candidates.map((candidate, index) => ({ value: String(index), label: candidate.label, description: `${describeCapabilities(choices[index])} · changes: ${diffStoredModel(stored, choices[index], preferences).map(change => change.label).join(" • ") || "none"}` })),
				{ value: "cancel", label: "Cancel" },
			]);
			if (picked === null || picked === "cancel") return;
			resolved = choices[Number(picked)];
		} else {
			const probeBase = normalizeEndpoint(base, api);
			const key = apiKeyFromProvider(providerId, provider);
			const probed = await probeModels(probeBase, resolveApiKeyForProbe(key.mode, key.value));
			if (!probed.ids.includes(modelId)) { ctx.ui.notify(`The gateway did not return ${modelId}.`, "warning"); return; }
			const infos = await collectProbedModelInfo(ctx, style, key, probed.baseUrl, [modelId], probed.infoById, undefined, undefined, api);
			resolved = infos.get(modelId)!;
		}
		const changes = diffStoredModel(stored, resolved, preferences);
		const preferenceLabels: Record<string, string> = { name: "display name", thinkingLevelMap: "supported thinking levels", contextWindow: "context window", maxTokens: "max output tokens", image: "image input" };
		const kept = Object.keys(preferences).filter(field => preferenceLabels[field]).map(field => preferenceLabels[field]);
		if (!changes.length) {
			rememberModelState(ctx, providerId, modelId, resolved, preferences);
			ctx.ui.notify(`Capabilities checked; no model config changes.${kept.length ? ` Manual settings kept: ${kept.join(", ")}.` : ""} ${describeCapabilities(resolved)}`, "info");
			return;
		}
		if (!(await ctx.ui.confirm(`Apply ${changes.length} capability change${changes.length === 1 ? "" : "s"}?`, `${modelId}: ${changes.map(change => change.label).join(" • ")}${kept.length ? `\nManual settings are kept: ${kept.join(", ")}. Unsupported saved limits require a new choice.` : ""}`))) return;
		const reviewed = await reviewPreferences(ctx, modelId, resolved, preferences);
		if (reviewed === null) return;
		const applied = await mutateModel(ctx, providerId, modelId, entry => applyMetaChanges(entry, resolved, changes, reviewed));
		if (applied) rememberModelState(ctx, providerId, modelId, resolved, reviewed);
	} catch (error) {
		ctx.ui.notify(`Could not refresh model capabilities: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

async function addModelsToProvider(ctx: CommandContext, providerId: string) {
	let provider: any;
	try {
		provider = loadModelsConfig().providers?.[providerId];
	} catch (error) {
		ctx.ui.notify(`Could not read ${MODELS_JSON_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}
	const style = providerStyleOf(provider);
	const manual = await promptManualModels(ctx, style);
	if (!manual) return;
	await addModelEntriesToProvider(ctx, providerId, manual.ids, undefined, manual.options);
}
