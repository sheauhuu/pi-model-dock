import { normalizeModelLimits, PROBE_TIMEOUT_MS } from "model-probe";
import { Models } from "@opencode-ai/models";
import type { Model, ProviderMap } from "@opencode-ai/models";
import { matchingModelId, modelInfoFromEntry, resolveCapabilities } from "./capabilities.ts";
import { loadModelsConfig } from "./config.ts";
import type { CommandContext, MetadataCandidate, ModelProbeInfo } from "./types.ts";

export type ModelsDevOption = { providerId: string; key: string; info: ModelProbeInfo; rank: number };
export type ModelsDevProvider = { id: string; name: string; baseUrl: string; env: string[]; doc?: string };
let catalogPromise: Promise<ProviderMap> | undefined;
let tablesPromise: Promise<Map<string, Map<string, ModelProbeInfo>>> | undefined;
// Endpoint defaults retained from model-probe for SDK providers with implicit APIs.
const DEFAULT_BASE_URLS: Record<string, string> = {
	openai: "https://api.openai.com/v1", groq: "https://api.groq.com/openai/v1",
	mistral: "https://api.mistral.ai/v1", xai: "https://api.x.ai/v1",
	cerebras: "https://api.cerebras.ai/v1", togetherai: "https://api.together.xyz/v1",
	deepinfra: "https://api.deepinfra.com/v1/openai", perplexity: "https://api.perplexity.ai",
	venice: "https://api.venice.ai/api/v1", aihubmix: "https://aihubmix.com/v1",
};

// Names, capabilities and provider lists share one request and offline fallback.
async function catalog(): Promise<ProviderMap> {
	catalogPromise ??= (async () => {
		try {
			const providers = await Models.make().providers({ signal: AbortSignal.timeout(PROBE_TIMEOUT_MS * 2) });
			if (!Object.keys(providers).length) throw new Error("Empty models.dev catalog");
			return providers;
		} catch { return (await import("@opencode-ai/models/snapshot")).providers; }
	})();
	try { return await catalogPromise; }
	catch (error) { catalogPromise = undefined; throw error; }
}

function modelInfo(model: Model): ModelProbeInfo {
	const info: ModelProbeInfo = {};
	if (model.name?.trim() && model.name.trim() !== model.id) info.name = model.name.trim();
	if (Number.isFinite(model.limit?.context) && model.limit.context > 0) info.contextWindow = model.limit.context;
	if (Number.isFinite(model.limit?.output) && model.limit.output > 0) info.maxTokens = model.limit.output;
	if (info.contextWindow !== undefined && info.maxTokens !== undefined) Object.assign(info, normalizeModelLimits(info.contextWindow, info.maxTokens));
	if (Array.isArray(model.modalities?.input)) {
		info.image = model.modalities.input.includes("image");
		info.video = model.modalities.input.includes("video");
	}
	if (typeof model.reasoning === "boolean") info.reasoning = model.reasoning;
	const effort = model.reasoning_options?.find(option => option.type === "effort");
	if (effort?.type === "effort") info.effortOptions = effort.values.filter(value => typeof value === "string");
	const cost = model.cost;
	if (cost && (Number.isFinite(cost.input) || Number.isFinite(cost.output))) {
		const rate = (value: number | undefined) => Number.isFinite(value) ? value! : 0;
		info.cost = { input: rate(cost.input), output: rate(cost.output), cacheRead: rate(cost.cache_read), cacheWrite: rate(cost.cache_write) };
	}
	return info;
}

function makerOf(id: string): string | undefined {
	const bare = id.split("/").pop()!.toLowerCase();
	if (/^(gpt-|o[134])/.test(bare)) return "openai";
	if (bare.startsWith("claude")) return "anthropic";
	if (bare.startsWith("glm")) return "zai";
	if (bare.startsWith("gemini")) return "google";
	if (bare.startsWith("deepseek")) return "deepseek";
	if (bare.startsWith("qwen")) return "qwen";
	if (bare.startsWith("kimi")) return "moonshotai";
}

async function catalogTables() {
	tablesPromise ??= (async () => {
		const providers = await catalog();
		return new Map(Object.entries(providers).map(([id, provider]) => [id,
			new Map(Object.entries(provider.models ?? {}).map(([key, model]) => [key, modelInfo(model)])),
		]));
	})();
	try { return await tablesPromise; }
	catch (error) { tablesPromise = undefined; throw error; }
}

export async function fetchModelsDevProviders(): Promise<Map<string, ModelsDevProvider>> {
	const providers = new Map<string, ModelsDevProvider>();
	for (const [id, provider] of Object.entries(await catalog())) {
		const baseUrl = provider.api?.trim() || DEFAULT_BASE_URLS[id];
		if (!baseUrl) continue;
		providers.set(id, { id, name: provider.name?.trim() || id, baseUrl: baseUrl.replace(/\/+$/, ""), env: provider.env ?? [], doc: provider.doc });
	}
	return providers;
}

export async function fetchModelsDevModels(providerId: string): Promise<Map<string, ModelProbeInfo>> {
	return (await catalogTables()).get(providerId) ?? new Map();
}

export async function fetchModelsDevInfoForBaseUrl(baseUrl: string): Promise<Map<string, ModelProbeInfo>> {
	try {
		const url = new URL(baseUrl);
		const path = (pathname: string) => pathname.replace(/\/+$/, "").replace(/\/v1$/i, "");
		for (const provider of (await fetchModelsDevProviders()).values()) {
			const endpoint = new URL(provider.baseUrl);
			if (endpoint.host.toLowerCase() === url.host.toLowerCase() && path(endpoint.pathname) === path(url.pathname)) return await fetchModelsDevModels(provider.id);
		}
	} catch { /* Offline failures leave gateway and installed catalog data usable. */ }
	return new Map();
}

export async function fetchModelsDevOptionsForModel(id: string): Promise<ModelsDevOption[]> {
	const tables = await catalogTables();
	const maker = makerOf(id);
	const result: ModelsDevOption[] = [];
	for (const [providerId, table] of tables) {
		for (const [key, info] of table) {
			if (matchingModelId(id, key)) result.push({ providerId, key, info, rank: providerId === maker ? 0 : 1 });
		}
	}
	return result.sort((a, b) => a.rank - b.rank || a.providerId.localeCompare(b.providerId) || a.key.localeCompare(b.key));
}

export function localModelCandidates(ctx: CommandContext, id: string, api?: string): MetadataCandidate[] {
	let all: any[];
	let customIds: Set<string>;
	try {
		all = ctx.modelRegistry?.getAll?.() ?? [];
		customIds = new Set(Object.keys(loadModelsConfig().providers ?? {}));
	} catch { return []; }
	const maker = makerOf(id);
	return all.filter(model => !customIds.has(model.provider) && typeof model.id === "string" && matchingModelId(id, model.id))
		.sort((a, b) => {
			const score = (model: any) => (model.provider === maker ? 0 : 4) + (model.api === api ? 0 : 1);
			return score(a) - score(b) || String(a.provider).localeCompare(String(b.provider));
		})
		.map(model => ({ source: "local catalog" as const, label: `local catalog: ${model.provider}/${model.id}`, info: modelInfoFromEntry(model) }));
}

export async function resolveModelMetadata(
	ctx: CommandContext, id: string, detected: ModelProbeInfo = {}, api?: string,
	endpointCatalog?: Map<string, ModelProbeInfo>,
): Promise<ModelProbeInfo> {
	const candidates: MetadataCandidate[] = [{ source: "gateway", label: "gateway", info: detected }];
	const endpointInfo = endpointCatalog?.get(id);
	if (endpointInfo) candidates.push({ source: "models.dev", label: "models.dev: matching endpoint", info: endpointInfo });
	try {
		for (const option of await fetchModelsDevOptionsForModel(id)) candidates.push({ source: "models.dev", label: `models.dev: ${option.providerId}/${option.key}`, info: option.info });
	} catch { /* Offline resolution continues through the installed catalog. */ }
	candidates.push(...localModelCandidates(ctx, id, api));
	return resolveCapabilities(id, candidates);
}
