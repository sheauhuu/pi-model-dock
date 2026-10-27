import {
	fetchGatewayWideInfo as probeGatewayWideInfo,
	fetchPerModelInfo as probePerModelInfo,
	probeInfoSummary,
} from "model-probe";
import { describeCapabilities, resolveModelInfo, supportedThinkingLevels } from "../capabilities.ts";
import { fetchPerModelInfo } from "../gateway-metadata.ts";
import { fetchModelsDevInfoForBaseUrl, resolveModelMetadata } from "../model-catalog.ts";
import { readModelState, removeModelStates, writeModelState } from "../model-state.ts";
import { applyPreferences, effectiveModelInfo } from "../model-settings.ts";
import { modelLabel } from "../model-name.ts";
import { resolveApiKeyForProbe, serializeApiKey } from "../api-key.ts";
import { BUILTIN_PROVIDER_IDS, loadModelsConfig, MODELS_JSON_PATH, removeProviderApiKey, saveModelsConfig, saveProviderApiKey } from "../config.ts";
import { buildModelEntry, modelIdOf, modelOptionsFromProbe } from "../model-entry.ts";
import { AUTO_PROBE_PROFILE } from "../presets.ts";
import { providerLabel } from "../provider-name.ts";
import type { GatewayProbeProfile } from "../presets.ts";
import type {
	ApiKeyMode,
	CommandContext,
	ModelOptions,
	ModelProbeInfo,
	ModelsConfig,
	ProbeItem,
	ProviderApi,
	ProviderStyle,
	SelectItem,
} from "../types.ts";
import { dedupe, normalizeEndpoint } from "../url.ts";

// Load config, hand the provider to a mutator, and save if it returns true.
export async function mutateProvider(
	ctx: CommandContext,
	providerId: string,
	mutate: (provider: any) => boolean | Promise<boolean>,
): Promise<boolean> {
	let config: ModelsConfig;
	try {
		config = loadModelsConfig();
	} catch (error) {
		ctx.ui.notify(`Could not read ${MODELS_JSON_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
		return false;
	}
	const provider = config.providers?.[providerId];
	if (!provider) {
		ctx.ui.notify(`Provider "${providerId}" no longer exists.`, "warning");
		return false;
	}

	const changed = await mutate(provider);
	if (!changed) return false;

	try {
		saveModelsConfig(config);
	} catch (error) {
		ctx.ui.notify(`Could not write ${MODELS_JSON_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
		return false;
	}
	await refreshModelRegistry(ctx);
	try { removeModelStates(providerId, (provider.models ?? []).map(modelIdOf)); }
	catch (error) { ctx.ui.notify(`Models saved, but old model preferences could not be cleaned up: ${error instanceof Error ? error.message : String(error)}`, "warning"); }
	return true;
}

// pi reads models.json once at startup and keeps it in memory. After every
// write, reload it into the running session so added/removed models show up
// in /model immediately instead of after a restart. Best-effort: the file is
// already saved, a failed refresh must not fail the mutation.
export async function refreshModelRegistry(ctx: CommandContext): Promise<void> {
	try {
		await ctx.modelRegistry?.refresh();
	} catch {
		// The config is on disk; a stale in-memory snapshot fixes itself on
		// restart, so a refresh failure is not worth an error dialog.
	}
}

// Mutate a single model entry in place and save.
export async function mutateModel(ctx: CommandContext, providerId: string, modelId: string, mutate: (model: any) => void): Promise<boolean> {
	return mutateProvider(ctx, providerId, (p) => {
		const models = Array.isArray(p.models) ? p.models : [];
		const index = models.findIndex((m: any) => modelIdOf(m) === modelId);
		if (index === -1) return false;
		// Strings become objects so per-field knobs have somewhere to live.
		if (typeof models[index] === "string") models[index] = { id: modelId, input: ["text", "image"] };
		mutate(models[index]);
		return true;
	}).then((saved) => {
		if (saved) ctx.ui.notify(`Updated "${modelId}".`, "info");
		return saved;
	});
}

export function describeProvider(providerId: string, provider: any): string {
	const modelCount = Array.isArray(provider?.models) ? provider.models.length : 0;
	const endpoint = typeof provider?.baseUrl === "string" ? provider.baseUrl : "(no baseUrl)";
	const api = typeof provider?.api === "string" ? provider.api : "(no api)";
	return `${providerLabel(providerId, provider)}\n${api} • ${modelCount} model${modelCount === 1 ? "" : "s"}\n${endpoint}`;
}

export function describeProviderInline(providerId: string, provider: any): { label: string; suffix: string; searchText: string } {
	const modelCount = Array.isArray(provider?.models) ? provider.models.length : 0;
	const endpoint = typeof provider?.baseUrl === "string" ? provider.baseUrl : "(no baseUrl)";
	const api = typeof provider?.api === "string" ? provider.api : "(no api)";
	// Flag ids that collide with pi's built-in providers — merging and shared
	// auth surprise users otherwise (see BUILTIN_COLLISION_WARNING).
	const collision = BUILTIN_PROVIDER_IDS.has(providerId) ? " • ⚠ built-in id" : "";
	const suffix = ` • ${api} • ${endpoint} • ${modelCount} model${modelCount === 1 ? "" : "s"}${collision}`;
	return {
		label: providerLabel(providerId, provider),
		suffix,
		searchText: `${providerLabel(providerId, provider)} ${api} ${endpoint} ${modelCount}`,
	};
}

export function providerModelItems(provider: any, providerId?: string): SelectItem[] {
	const models = Array.isArray(provider?.models) ? provider.models : [];
	return models
		.map((model: any) => {
			const id = typeof model === "string" ? model.trim() : typeof model?.id === "string" ? model.id.trim() : "";
			if (!id) return null;

			const details: string[] = [];
			if (model && typeof model === "object") {
				const state = providerId ? readModelState(providerId, id) : {};
				const levels = supportedThinkingLevels(effectiveModelInfo(state.metadata ?? {}, state.preferences ?? {}));
				details.push(`thinking: ${levels?.join("/") ?? "unknown"}`);
				details.push(`image: ${state.metadata?.image === undefined && state.preferences?.image === undefined ? "unknown" : model.input?.includes("image") ? "on" : "off"}`);
				if (typeof model.contextWindow === "number") details.push(`context ${model.contextWindow}`);
				if (typeof model.maxTokens === "number") details.push(`max-out ${model.maxTokens}`);
				if (model.cost && typeof model.cost === "object") details.push(`$${model.cost.input}/$${model.cost.output} per 1M`);
			}

			return {
				value: id,
				label: modelLabel(id, model),
				suffix: details.length > 0 ? ` • ${details.join(" • ")}` : "",
				searchText: `${modelLabel(id, model)} ${details.join(" ")}`,
			};
		})
		.filter((item: any): item is SelectItem => item !== null);
}

function normalizeStoredEndpoint(provider: any): string {
	const endpoint = typeof provider?.baseUrl === "string" ? provider.baseUrl.trim() : "";
	if (!endpoint) return "";
	const stored = provider?.api;
	const api: ProviderApi =
		stored === "anthropic-messages" || stored === "openai-responses" ? stored : "openai-completions";
	try {
		return normalizeEndpoint(endpoint, api);
	} catch {
		return endpoint.replace(/\/+$/, "");
	}
}

export function findProvidersByEndpoint(config: ModelsConfig, endpoint: string): string[] {
	return Object.entries(config.providers ?? {})
		.filter(([, provider]) => normalizeStoredEndpoint(provider) === endpoint)
		.map(([providerId]) => providerId)
		.sort((a, b) => a.localeCompare(b));
}

// Delete a whole provider from the models config.
export async function removeProvider(ctx: CommandContext, providerId: string): Promise<boolean> {
	let config: ModelsConfig;
	try {
		config = loadModelsConfig();
	} catch (error) {
		ctx.ui.notify(`Could not read ${MODELS_JSON_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
		return false;
	}
	if (!config.providers?.[providerId]) {
		ctx.ui.notify(`Provider "${providerId}" no longer exists.`, "warning");
		return false;
	}
	delete config.providers[providerId];
	try {
		saveModelsConfig(config);
	} catch (error) {
		ctx.ui.notify(`Could not write ${MODELS_JSON_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
		return false;
	}
	await refreshModelRegistry(ctx);
	// Drop the auth.json entry along with the provider so no orphan key stays
	// behind. Best-effort: a failing auth write must not undo the deletion.
	try {
		removeProviderApiKey(providerId);
		removeModelStates(providerId);
	} catch (error) {
		ctx.ui.notify(`Provider deleted, but its auth.json entry could not be removed: ${error instanceof Error ? error.message : String(error)}`, "warning");
	}
	ctx.ui.notify(`Deleted provider "${providerId}" from ${MODELS_JSON_PATH}`, "info");
	return true;
}

export async function persistProvider(ctx: CommandContext, providerId: string, providerConfig: any): Promise<boolean> {	let config: ModelsConfig;
	try {
		config = loadModelsConfig();
	} catch (error) {
		ctx.ui.notify(`Could not read ${MODELS_JSON_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
		return false;
	}

	config.providers ||= {};
	if (config.providers[providerId]) {
		// Names are validated unique at prompt time; this only triggers if the
		// config changed underneath us. Refuse rather than overwrite.
		ctx.ui.notify(`Provider "${providerId}" already exists. Not overwriting.`, "error");
		return false;
	}

	config.providers[providerId] = providerConfig;
	try {
		saveModelsConfig(config);
	} catch (error) {
		ctx.ui.notify(`Could not write ${MODELS_JSON_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
		return false;
	}
	await refreshModelRegistry(ctx);
	return true;
}

// Write a provider's key into auth.json (pi's official credential file, the
// one /login writes). Call AFTER persistProvider succeeds. No-op where keys
// stay inline (OMP) or nothing was entered.
export function persistApiKey(
	ctx: CommandContext,
	providerId: string,
	apiKey: { mode: ApiKeyMode; value?: string },
	style: ProviderStyle,
): boolean {
	const serialized = serializeApiKey(apiKey.mode, apiKey.value, style);
	if (!serialized) return true;
	try {
		saveProviderApiKey(providerId, serialized);
		return true;
	} catch (error) {
		ctx.ui.notify(
			`Provider saved, but the API key could not be written to auth.json: ${error instanceof Error ? error.message : String(error)}. Run "/login ${providerId}" to set it.`,
			"warning",
		);
		return false;
	}
}

export async function addModelEntriesToProvider(
	ctx: CommandContext,
	providerId: string,
	ids: string[],
	infoById?: Map<string, ModelProbeInfo>,
	// Explicit per-model options from the manual metadata prompts; wins over
	// the resolved values (contextWindow falls back to resolved when unset).
	optionOverrides?: Map<string, ModelOptions>,
) {
	const existing = new Set<string>();
	try {
		const provider = loadModelsConfig().providers?.[providerId];
		for (const m of Array.isArray(provider?.models) ? provider.models : []) existing.add(modelIdOf(m));
	} catch {
		// fall through; mutateProvider re-reads and reports errors
	}
	const fresh = dedupe(ids).filter((id) => id && !existing.has(id));
	if (fresh.length === 0) {
		ctx.ui.notify("Nothing to add — all selected models already exist.", "info");
		return;
	}

	const metadata = new Map<string, ModelProbeInfo>();
	for (const id of fresh) {
		const override = optionOverrides?.get(id);
		metadata.set(id, override?.metadata ?? infoById?.get(id) ?? await resolveModelMetadata(ctx, id));
	}
	let detectedCount = 0;
	const saved = await mutateProvider(ctx, providerId, (p) => {
		const api = typeof p.api === "string" ? (p.api as ProviderApi) : undefined;
		const models = Array.isArray(p.models) ? p.models : [];
		for (const id of fresh) {
			const mergedInfo = resolveModelInfo(id, metadata.get(id), undefined, api);
			if (probeInfoSummary(mergedInfo).length > 0) detectedCount++;
			const override = optionOverrides?.get(id);
			const opts = override
				? {
						...override,
						name: override.name ?? mergedInfo.name,
						contextWindow: override.contextWindow ?? mergedInfo.contextWindow,
						maxTokens: override.maxTokens ?? mergedInfo.maxTokens,
					}
				: modelOptionsFromProbe(mergedInfo);
			const entry = buildModelEntry(id, opts);
			applyPreferences(entry, override?.preferences ?? {}, mergedInfo);
			models.push(entry);
		}
		p.models = models;
		return true;
	});
	if (saved) {
		for (const id of fresh) rememberModelState(ctx, providerId, id, metadata.get(id)!, optionOverrides?.get(id)?.preferences);
		const detail =
			detectedCount > 0 ? ` — resolved metadata for ${detectedCount} model${detectedCount === 1 ? "" : "s"}` : "";
		ctx.ui.notify(`Added ${fresh.length} model${fresh.length === 1 ? "" : "s"} to "${providerId}"${detail}.`, "info");
	}
}

// Gateway-wide metadata sources: each answers for EVERY model in a single
// call (LiteLLM /model/info, /model_group/info, the site public catalog).
// Cheap enough to run before the model picker so it can show real values.
// Ollama has no gateway-wide source — its native probing is per-model.
// Thin wrapper over model-probe that resolves the api key first.
export async function fetchGatewayWideInfo(
	style: ProviderStyle,
	apiKey: { mode: ApiKeyMode; value?: string },
	baseUrl: string,
	profile: GatewayProbeProfile,
): Promise<Map<string, ModelProbeInfo>> {
	// Ollama and Gemini have no LiteLLM-style gateway-wide metadata endpoints.
	if (style === "ollama" || style === "gemini") return new Map();
	return probeGatewayWideInfo(baseUrl, { apiKey: resolveApiKeyForProbe(apiKey.mode, apiKey.value), profile });
}

// Picker summaries include unknown fields and the source of each known value.
export function probePickerItems(
	ids: string[],
	infoById: Map<string, ModelProbeInfo>,
	modelsDev?: Map<string, ModelProbeInfo>,
	api?: ProviderApi,
): ProbeItem[] {
	return ids.map((id) => ({
		value: id,
		label: modelLabel(id, infoById.get(id) ?? modelsDev?.get(id)),
		description: describeCapabilities(resolveModelInfo(id, infoById.get(id), modelsDev, api)),
	}));
}

export async function collectProbedModelInfo(
	ctx: CommandContext,
	style: ProviderStyle,
	apiKey: { mode: ApiKeyMode; value?: string },
	baseUrl: string,
	ids: string[],
	listInfo: Map<string, ModelProbeInfo>,
	gatewayWide?: Map<string, ModelProbeInfo>,
	modelsDev?: Map<string, ModelProbeInfo>,
	// The provider API helps rank installed catalog references.
	api?: ProviderApi,
): Promise<Map<string, ModelProbeInfo>> {
	ctx.ui.notify("Fetching model metadata (context, max-out, image/video, reasoning) ...", "info");
	const profile = AUTO_PROBE_PROFILE;
	const resolvedKey = resolveApiKeyForProbe(apiKey.mode, apiKey.value);

	const gw = gatewayWide ?? (await fetchGatewayWideInfo(style, apiKey, baseUrl, profile));

	// models.dev catalog tier (exact per-model entries — above local rules,
	// below detected values), matched by base URL. One cached call; empty when
	// the endpoint isn't a known provider.
	const dev =
		modelsDev ?? (profile.modelsDev && style !== "ollama" && style !== "gemini" ? await fetchModelsDevInfoForBaseUrl(baseUrl) : undefined);

	// A gateway-wide response can be partial. Fetch details for models whose
	// image, reasoning, limits, or exact effort levels are still unknown.
	let details = new Map<string, ModelProbeInfo>();
	if (style === "ollama") {
		details = await probePerModelInfo(baseUrl, ids, { apiKey: resolvedKey, ollama: true });
	} else if (profile.perModelDetails) {
		const missing = ids.filter(id => {
			const info = { ...listInfo.get(id), ...gw.get(id) };
			return info.image === undefined || info.reasoning === undefined || info.contextWindow === undefined || info.maxTokens === undefined || (info.reasoning !== false && !supportedThinkingLevels(info));
		});
		details = await fetchPerModelInfo(baseUrl, missing, resolvedKey);
	}

	// Merge actual gateway declarations, then fill missing fields from references.
	return new Map(await Promise.all(ids.map(async id => [id, await resolveModelMetadata(ctx, id, { ...listInfo.get(id), ...gw.get(id), ...details.get(id) }, api, dev)] as const)));
}

// The ollama style leaves a compat object with BOTH flags false; every other
// style writes only supportsDeveloperRole. Keying on compat's presence alone
// misreads plain OpenAI-compatible providers as Ollama.
export function providerStyleOf(provider: unknown): ProviderStyle {
	if (!provider || typeof provider !== "object") return "openai";
	if ("api" in provider) {
		const api = provider.api;
		if (api === "anthropic-messages") return "anthropic";
		if (api === "openai-responses") return "openai-responses";
		if (api === "google-generative-ai") return "gemini";
	}
	if ("compat" in provider && provider.compat && typeof provider.compat === "object") {
		const compat = provider.compat;
		if ("supportsDeveloperRole" in compat && "supportsReasoningEffort" in compat) {
			const developerRole = compat.supportsDeveloperRole;
			const reasoningEffort = compat.supportsReasoningEffort;
			if (developerRole === false && reasoningEffort === false) return "ollama";
		}
	}
	return "openai";
}

export { fetchModelsDevOptionsForModel, localModelCandidates } from "../model-catalog.ts";
export type { ModelsDevOption } from "../model-catalog.ts";

export function rememberModelState(
	ctx: CommandContext, providerId: string, modelId: string, metadata: ModelProbeInfo,
	preferences?: import("../types.ts").ModelPreferences,
) {
	try {
		const state = readModelState(providerId, modelId);
		writeModelState(providerId, modelId, { metadata, preferences: preferences ?? state.preferences });
	} catch (error) {
		ctx.ui.notify(`Model saved, but metadata/preferences could not be saved: ${error instanceof Error ? error.message : String(error)}`, "warning");
	}
}
