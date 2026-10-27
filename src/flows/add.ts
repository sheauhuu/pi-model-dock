import {
	probeDeveloperRole,
	probeInfoSummary,
} from "model-probe";
import { probeModels } from "../gateway-metadata.ts";
import { fetchModelsDevInfoForBaseUrl, fetchModelsDevModels, fetchModelsDevProviders, resolveModelMetadata } from "../model-catalog.ts";
import type { ModelsDevProvider } from "../model-catalog.ts";
import { applyPreferences } from "../model-settings.ts";
import { resolveApiKeyForProbe } from "../api-key.ts";
import { loadModelsConfig, MODELS_JSON_PATH } from "../config.ts";
import { buildProviderConfig } from "../model-entry.ts";
import { AUTO_PROBE_PROFILE } from "../presets.ts";
import { providerLabel } from "../provider-name.ts";
import type { ApiKeyMode, CommandContext, ModelOptions, ModelProbeInfo, ModelsConfig, ProviderApi, ProviderStyle } from "../types.ts";
import { pickMany, selectOne } from "../ui/select.ts";
import { promptApiKey, promptEndpoint, promptManualModels, promptProviderIdentity, promptProviderStyle } from "../ui/prompts.ts";
import { buildProbeUrl, dedupe, hasExplicitScheme, normalizeEndpoint } from "../url.ts";
import { collectProbedModelInfo, fetchGatewayWideInfo, findProvidersByEndpoint, persistApiKey, persistProvider, probePickerItems, rememberModelState } from "./shared.ts";

// Manual model entry (id → per-model metadata menu) lives in ui/prompts.ts as
// promptManualModels; every "add by hand" path below funnels through it.

// Pick a known API provider from the models.dev catalog.
async function pickCatalogProvider(ctx: CommandContext): Promise<ModelsDevProvider | null> {
	ctx.ui.notify("Fetching the models.dev provider catalog ...", "info");
	let providers: Map<string, ModelsDevProvider>;
	try {
		providers = await fetchModelsDevProviders();
	} catch (error) {
		ctx.ui.notify(`Could not fetch the models.dev catalog: ${error instanceof Error ? error.message : String(error)}`, "error");
		return null;
	}

	const items = [...providers.values()]
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((p) => ({
			value: p.id,
			label: p.name,
			suffix: ` • ${p.baseUrl}`,
			description: p.env.length > 0 ? `env: ${p.env.join(" / ")}` : undefined,
			searchText: `${p.id} ${p.name} ${p.baseUrl}`,
		}));
	const choice = await selectOne(ctx, "models.dev providers", items);
	if (!choice) return null;
	return providers.get(choice) ?? null;
}

async function confirmEndpointReuse(ctx: CommandContext, normalizedEndpoint: string): Promise<boolean> {
	let config: ModelsConfig;
	try {
		config = loadModelsConfig();
	} catch (error) {
		ctx.ui.notify(`Could not read ${MODELS_JSON_PATH}: ${error instanceof Error ? error.message : String(error)}`, "error");
		return false;
	}

	const providersWithSameEndpoint = findProvidersByEndpoint(config, normalizedEndpoint);
	if (providersWithSameEndpoint.length === 0) return true;

	return ctx.ui.confirm(
		"Endpoint already exists",
		`This endpoint is already used by:\n${providersWithSameEndpoint.map((id) => `- ${id}`).join("\n")}\n\nAdd another provider with the same endpoint?`,
	);
}

// Catalog path: the provider is known to models.dev, so the model list and
// its metadata come from the catalog — no probing of the gateway at all.
async function addFromCatalog(ctx: CommandContext) {
	const provider = await pickCatalogProvider(ctx);
	if (!provider) return;

	// Catalog providers are OpenAI-compatible by construction (they carry a
	// baseUrl); chat completions is the flavor every one of them supports.
	const style: ProviderStyle = "openai";
	const api: ProviderApi = "openai-completions";

	let endpoint: string;
	try {
		endpoint = normalizeEndpoint(provider.baseUrl, api);
	} catch (error) {
		ctx.ui.notify(`Invalid catalog endpoint "${provider.baseUrl}": ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}
	if (!(await confirmEndpointReuse(ctx, endpoint))) return;

	if (provider.env.length > 0) {
		ctx.ui.notify(`${provider.name} expects the ${provider.env.join(" / ")} env var.`, "info");
	}
	const identity = await promptProviderIdentity(ctx, endpoint, provider.id);
	if (!identity) return;
	const { id: providerId, name } = identity;

	const apiKey = await promptApiKey(ctx);
	if (!apiKey) return;
	if (apiKey.mode === "none") {
		ctx.ui.notify('No API key selected. Using "dummy" automatically in auth.json.', "info");
	}

	ctx.ui.notify(`Fetching the model list for ${provider.name} from models.dev ...`, "info");
	const catalog = await fetchModelsDevModels(provider.id);
	let ids: string[];
	let infoById: Map<string, ModelProbeInfo> | undefined;
	let overrides: Map<string, ModelOptions> | undefined;
	if (catalog.size > 0) {
		const available = new Map(await Promise.all([...catalog.keys()].map(async id => [id, await resolveModelMetadata(ctx, id, {}, api, catalog)] as const)));
		const picked = await pickMany(ctx, "Select models", probePickerItems([...catalog.keys()], available, undefined, api));
		if (!picked || picked.length === 0) return;
		ids = picked;
		infoById = new Map(picked.map(id => [id, available.get(id)!]));
	} else {
		ctx.ui.notify(`models.dev lists no models for ${provider.name} — enter ids by hand.`, "warning");
		const manual = await promptManualModels(ctx, style);
		if (!manual) return;
		ids = manual.ids;
		overrides = manual.options;
	}

	// No gateway calls on this path — developer-role support stays at the safe
	// default (off). Flip it later via Edit provider if the endpoint supports it.
	const providerConfig = buildProviderConfig(
		style,
		api,
		endpoint,
		apiKey,
		dedupe(ids),
		infoById,
		undefined,
		overrides,
	);
	if (name) providerConfig.name = name;
	for (const model of providerConfig.models) applyPreferences(model, overrides?.get(model.id)?.preferences ?? {}, overrides?.get(model.id)?.metadata ?? infoById?.get(model.id));
	if (!(await persistProvider(ctx, providerId, providerConfig))) return;
	persistApiKey(ctx, providerId, apiKey, style);
	for (const id of ids) rememberModelState(ctx, providerId, id, overrides?.get(id)?.metadata ?? infoById?.get(id) ?? {}, overrides?.get(id)?.preferences);

	const withMeta = infoById ? ids.filter((id) => probeInfoSummary(infoById.get(id) ?? {}).length > 0).length : 0;
	ctx.ui.notify(
		`Saved provider "${providerLabel(providerId, providerConfig)}" to ${MODELS_JSON_PATH} — models and metadata from models.dev` +
			(withMeta > 0 ? ` (${withMeta} model${withMeta === 1 ? "" : "s"} with metadata)` : ""),
		"info",
	);
	ctx.ui.notify("Open /model to use your new provider.", "info");
}

// Model collection: auto-detect reads the gateway; manual ids use catalog
// references without querying the gateway model list.
async function collectModelIds(
	ctx: CommandContext,
	style: ProviderStyle,
	api: ProviderApi,
	apiKey: { mode: ApiKeyMode; value?: string },
	normalizedEndpoint: string,
	trimmedEndpointInput: string,
): Promise<{ ids: string[]; infoById?: Map<string, ModelProbeInfo>; baseUrl?: string; options?: Map<string, ModelOptions> } | null> {
	const modelMode = await selectOne(ctx, "Models", ["Auto-detect from the endpoint", "Add manually"]);
	if (!modelMode) return null;
	if (modelMode !== "Auto-detect from the endpoint") {
		return promptManualModels(ctx, style);
	}

	let baseUrl = normalizedEndpoint;
	while (true) {
		try {
			ctx.ui.notify(`Probing ${buildProbeUrl(baseUrl)} ...`, "info");
			const probed = await probeModels(baseUrl, resolveApiKeyForProbe(apiKey.mode, apiKey.value));
			// The variant that actually answered (±/v1 adapted) becomes the
			// provider's baseUrl.
			baseUrl = probed.baseUrl;
			if (probed.ids.length === 0) {
				ctx.ui.notify("Probe succeeded but returned no models. Switching to manual entry.", "warning");
				const manual = await promptManualModels(ctx, style);
				return manual ? { ...manual, baseUrl } : null;
			}

			// Gateway-wide metadata (one call per source) — fetch BEFORE the picker so
			// it shows real detected values instead of catalog/rule guesses.
			let gatewayWide: Map<string, ModelProbeInfo> | undefined;
			if (AUTO_PROBE_PROFILE.modelInfo || AUTO_PROBE_PROFILE.publicCatalog || AUTO_PROBE_PROFILE.modelGroupInfo) {
				ctx.ui.notify("Fetching model metadata (context, max-out, image/video, reasoning) ...", "info");
				gatewayWide = await fetchGatewayWideInfo(style, apiKey, probed.baseUrl, AUTO_PROBE_PROFILE);
				if (gatewayWide.size > 0) {
					for (const [id, info] of gatewayWide) {
						probed.infoById.set(id, { ...(probed.infoById.get(id) ?? {}), ...info });
					}
				}
			}

			// models.dev catalog tier — above the local rules, below detected values.
			const modelsDev = style !== "ollama" && style !== "gemini" ? await fetchModelsDevInfoForBaseUrl(probed.baseUrl) : undefined;

			const pickerInfo = new Map(await Promise.all(probed.ids.map(async id => [id, await resolveModelMetadata(ctx, id, probed.infoById.get(id), api, modelsDev)] as const)));
			const picked = await pickMany(ctx, "Select models", probePickerItems(probed.ids, pickerInfo, undefined, api));
			if (!picked || picked.length === 0) return null;

			const infoById = await collectProbedModelInfo(ctx, style, apiKey, probed.baseUrl, picked, probed.infoById, gatewayWide, modelsDev, api);
			return { ids: picked, infoById, baseUrl };
		} catch (error) {
			const schemeHint = hasExplicitScheme(trimmedEndpointInput) ? "" : " No http:// or https:// was provided.";
			ctx.ui.notify(`Auto probe failed: ${error instanceof Error ? error.message : String(error)}.${schemeHint}`, "warning");
			const action = await selectOne(ctx, "Probe failed — what next?", [
				{ value: "retry", label: "Retry", description: "Probe again" },
				{ value: "manual", label: "Add models manually", description: "Enter model ids by hand" },
				{ value: "cancel", label: "Cancel", description: "Abort adding this provider" },
			]);
			if (action === "retry") continue;
			if (action === "manual") {
				const manual = await promptManualModels(ctx, style);
				return manual ? { ...manual, baseUrl } : null;
			}
			return null;
		}
	}
}

async function addCustom(ctx: CommandContext) {
	const styleChoice = await promptProviderStyle(ctx);
	if (!styleChoice) return;
	const { style, api } = styleChoice;

	const endpoint = await promptEndpoint(ctx, style, api);
	if (!endpoint) return;
	if (!(await confirmEndpointReuse(ctx, endpoint.normalized))) return;

	const identity = await promptProviderIdentity(ctx, endpoint.normalized);
	if (!identity) return;
	const { id: providerId, name } = identity;

	const apiKey = await promptApiKey(ctx);
	if (!apiKey) return;
	if (apiKey.mode === "none") {
		ctx.ui.notify(
			style === "ollama"
				? 'No API key selected. Using "ollama" automatically in auth.json.'
				: 'No API key selected. Using "dummy" automatically in auth.json.',
			"info",
		);
	}

	const collected = await collectModelIds(ctx, style, api, apiKey, endpoint.normalized, endpoint.raw);
	if (!collected || collected.ids.length === 0) return;

	// pi sends system messages with the "developer" role for reasoning models
	// when the endpoint supports it; gateways that don't (e.g. Kimi's
	// subscription endpoint) answer 400. Probe it once with a tiny completion.
	let developerRole: boolean | undefined;
	if (style === "openai" || style === "openai-responses") {
		const probeBase = collected.baseUrl ?? endpoint.normalized;
		developerRole = await probeDeveloperRole(probeBase, resolveApiKeyForProbe(apiKey.mode, apiKey.value), collected.ids[0]);
		if (developerRole === false) {
			ctx.ui.notify("This endpoint rejects the developer role — it will be disabled in the provider config.", "info");
		} else if (developerRole === undefined) {
			ctx.ui.notify("Could not probe developer-role support — defaulting to off (safe for every endpoint).", "info");
		}
	}

	const providerConfig = buildProviderConfig(
		style,
		api,
		// After a successful probe this is the base variant that actually
		// answered; otherwise the endpoint as entered.
		collected.baseUrl ?? endpoint.normalized,
		apiKey,
		dedupe(collected.ids),
		collected.infoById,
		developerRole,
		collected.options,
	);
	if (name) providerConfig.name = name;
	for (const model of providerConfig.models) applyPreferences(model, collected.options?.get(model.id)?.preferences ?? {}, collected.options?.get(model.id)?.metadata ?? collected.infoById?.get(model.id));
	if (!(await persistProvider(ctx, providerId, providerConfig))) return;
	persistApiKey(ctx, providerId, apiKey, style);
	for (const id of collected.ids) rememberModelState(ctx, providerId, id, collected.options?.get(id)?.metadata ?? collected.infoById?.get(id) ?? {}, collected.options?.get(id)?.preferences);

	const infoById = collected.infoById ?? new Map(collected.ids.map(id => [id, collected.options?.get(id)?.metadata]));
	const probedCount = collected.ids.filter(id => Object.values(infoById.get(id)?.sources ?? {}).includes("gateway")).length;
	const referenceCount = collected.ids.filter(id => {
		const sources = Object.values(infoById.get(id)?.sources ?? {});
		return !sources.includes("gateway") && sources.length > 0;
	}).length;
	const unknownCount = collected.ids.length - probedCount - referenceCount;
	const summary: string[] = [];
	if (probedCount > 0) summary.push(`gateway metadata for ${probedCount}`);
	if (referenceCount > 0) summary.push(`catalog/rule references for ${referenceCount}`);
	if (unknownCount > 0) summary.push(`unknown metadata for ${unknownCount}`);
	ctx.ui.notify(
		`Saved provider "${providerLabel(providerId, providerConfig)}" to ${MODELS_JSON_PATH}` + (summary.length > 0 ? ` — context/image/reasoning: ${summary.join(", ")}` : ""),
		"info",
	);
	ctx.ui.notify("Open /model to use your new provider.", "info");
}

export async function addProviderFlow(ctx: CommandContext) {
	const source = await selectOne(ctx, "Add provider", [
		{
			value: "catalog",
			label: "From models.dev catalog",
			description: "Known API providers (OpenRouter, DeepSeek, ...) — model list and metadata from models.dev, no probing",
		},
		{ value: "custom", label: "Custom endpoint", description: "Any compatible endpoint — auto-detect models, or add them by hand" },
	]);
	if (source === "catalog") return addFromCatalog(ctx);
	if (source === "custom") return addCustom(ctx);
}
