import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ModelCostInfo } from "model-probe";
import type { ModelProbeInfo as ProbeModelInfo } from "model-probe";

export type ProviderApi = "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";
export type ProviderStyle = "openai" | "openai-responses" | "anthropic" | "ollama" | "gemini";
export type ApiKeyMode = "env" | "literal" | "shell" | "none";
export type ProviderIdentity = { id: string; name?: string };
export type CapabilityField = "name" | "contextWindow" | "maxTokens" | "image" | "video" | "reasoning" | "thinkingLevelMap" | "alwaysThinking" | "cost";
export type MetadataSource = "gateway" | "models.dev" | "local catalog" | "local rules";
export type MetadataCandidate = { source: MetadataSource; label: string; info: ModelProbeInfo };
export type ModelProbeInfo = ProbeModelInfo & {
	name?: string;
	thinkingLevelMap?: Record<string, string | null>;
	sources?: Partial<Record<CapabilityField, string>>;
	candidates?: MetadataCandidate[];
};
export type ModelPreferences = {
	name?: string | null;
	thinkingLevelMap?: Record<string, string | null>;
	contextWindow?: number | null;
	maxTokens?: number | null;
	image?: boolean;
};
export type ModelState = { metadata?: ModelProbeInfo; preferences?: ModelPreferences };
// Pi thinking levels used to describe model capabilities.
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export const REASONING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

// Per-model knobs the wizard can write. apiKey lives at provider scope, not here.
export type ModelOptions = {
	name?: string;
	reasoning: ThinkingLevel;
	image: boolean;
	contextWindow?: number;
	maxTokens?: number;
	// USD per 1M tokens, from the gateway or the models.dev catalog. Only real
	// sources — never guessed.
	cost?: ModelCostInfo;
	// Exact supported levels learned from metadata or declared manually.
	thinkingLevelMap?: Record<string, string | null>;
	metadata?: ModelProbeInfo;
	preferences?: ModelPreferences;
};

// Model metadata types come from the model-probe package (probing logic was
// extracted there); re-exported here so the rest of the extension has one
// place to import from.
export type { ModelCostInfo, ProbeResult } from "model-probe";

export type ModelsConfig = {
	providers?: Record<string, any>;
};

export type ProbeItem = {
	value: string;
	label: string;
	description?: string;
};

export type SelectItem = {
	value: string;
	label: string;
	suffix?: string;
	description?: string;
	searchText?: string;
};

export type CommandContext = Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1];
