import { serializeApiKey } from "./api-key.ts";
import { SPLIT_AUTH } from "./config.ts";
import { resolveModelInfo, supportedThinkingLevels, thinkingMap } from "./capabilities.ts";
import type {
	ApiKeyMode,
	ModelOptions,
	ModelProbeInfo,
	ProviderApi,
	ProviderStyle,
} from "./types.ts";

// Unknown capability fields stay unknown in metadata. Runtime declarations
// use text-only/no reasoning until a source or a manual choice supplies them.
export function modelOptionsFromProbe(info: ModelProbeInfo | undefined): ModelOptions {
	info ??= {};
	const opts: ModelOptions = {
		name: info.name,
		reasoning: info.reasoning === true ? "high" : "off",
		image: info.image ?? false,
		contextWindow: info.contextWindow,
		maxTokens: info.maxTokens,
		cost: info.cost,
		metadata: info,
	};
	const map = thinkingMap(info);
	if (map) { opts.thinkingLevelMap = map; opts.reasoning = supportedThinkingLevels(info)!.at(-1)!; }
	else if (info.alwaysThinking && info.reasoning) opts.thinkingLevelMap = { off: null };
	return opts;
}

export function buildModelEntry(
	id: string,
	opts: ModelOptions,
): any {
	const entry: any = {
		id,
		// image comes from the probe (default: off). Text-only models have
		// images silently dropped by pi, so this must match reality. pi's
		// input union has no "video", so video never lands here.
		input: opts.image ? ["text", "image"] : ["text"],
	};
	if (opts.name?.trim() && opts.name.trim() !== id) entry.name = opts.name.trim();

	if (typeof opts.contextWindow === "number" && opts.contextWindow > 0) {
		entry.contextWindow = opts.contextWindow;
	}
	if (typeof opts.maxTokens === "number" && opts.maxTokens > 0) {
		entry.maxTokens = opts.maxTokens;
	}

	// List prices so pi's usage accounting can estimate cost for custom
	// providers too. Only real sources (gateway-reported or models.dev).
	if (opts.cost) {
		entry.cost = opts.cost;
	}

	if (opts.thinkingLevelMap) {
		// The probe knew the provider's exact thinking levels (e.g. OpenAI
		// effort_options) — write that map verbatim instead of deriving one.
		entry.reasoning = true;
		entry.thinkingLevelMap = opts.thinkingLevelMap;
	} else {
		entry.reasoning = opts.reasoning !== "off";
	}
	return entry;
}

export function buildProviderConfig(
	style: ProviderStyle,
	api: ProviderApi,
	baseUrl: string,
	apiKey: { mode: ApiKeyMode; value?: string },
	modelIds: string[],
	infoById?: Map<string, ModelProbeInfo>,
	developerRole?: boolean,
	// Explicit per-model options from the manual-entry metadata prompts; these
	// win over the resolved probe/rule values (contextWindow falls back to the
	// resolved value when the user left it unset).
	optionOverrides?: Map<string, ModelOptions>,
) {
	const serializedApiKey = serializeApiKey(apiKey.mode, apiKey.value, style);
	const config: any = {
		baseUrl,
		api,
		// With the auth split, the key goes to auth.json (written by the caller
		// after the provider is persisted) and stays out of models.json, exactly
		// like pi's own /login flow. Only OMP keeps it inline.
		...(!SPLIT_AUTH && serializedApiKey ? { apiKey: serializedApiKey } : {}),
		models: modelIds.map((id) => {
			// Preserve resolved source information and leave missing fields unknown.
			const info = resolveModelInfo(id, infoById?.get(id), undefined, api);
			const override = optionOverrides?.get(id);
			const modelOpts = override
				? {
						...override,
						name: override.name ?? info.name,
						contextWindow: override.contextWindow ?? info.contextWindow,
						maxTokens: override.maxTokens ?? info.maxTokens,
					}
				: modelOptionsFromProbe(info);
			return buildModelEntry(id, modelOpts);
		}),
	};

	if (style === "ollama") {
		if (!SPLIT_AUTH && !config.apiKey) config.apiKey = "ollama";
		config.compat = {
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
		};
	} else if (style === "openai" || style === "openai-responses") {
		// pi-ai auto-detects developer-role support only for a handful of known
		// providers (by id / baseUrl); everyone else gets the probed value.
		// When the probe couldn't tell, default to false — sending "system"
		// instead of "developer" is accepted everywhere, the reverse is not.
		config.compat = { supportsDeveloperRole: developerRole ?? false };
	}

	return config;
}

export function modelIdOf(model: any): string {
	return typeof model === "string" ? model.trim() : typeof model?.id === "string" ? model.id.trim() : "";
}

export function findModel(provider: any, id: string): any {
	const models = Array.isArray(provider?.models) ? provider.models : [];
	return models.find((m: any) => modelIdOf(m) === id);
}
