import { applyKnownModelFallback, normalizeModelIdCandidates } from "model-probe";
import { PI_THINKING_LEVELS } from "./types.ts";
import type { CapabilityField, MetadataCandidate, ModelProbeInfo, ThinkingLevel } from "./types.ts";

export const CAPABILITY_FIELDS: CapabilityField[] = ["name", "contextWindow", "maxTokens", "image", "video", "reasoning", "thinkingLevelMap", "alwaysThinking", "cost"];
const EFFORT_ALIASES: Record<string, string> = { off: "off", none: "off", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", extended: "xhigh", max: "max" };

export function thinkingMap(info: ModelProbeInfo): Record<string, string | null> | undefined {
	if (info.reasoning === false) return undefined;
	let map: Record<string, string | null> | undefined;
	if (info.thinkingLevelMap && typeof info.thinkingLevelMap === "object") {
		map = {};
		for (const level of PI_THINKING_LEVELS) {
			const value = info.thinkingLevelMap[level];
			map[level] = typeof value === "string" && value.trim() ? value : null;
		}
	} else if (info.effortOptions?.length) {
		map = Object.fromEntries(PI_THINKING_LEVELS.map(level => [level, null]));
		for (const raw of info.effortOptions) {
			const level = EFFORT_ALIASES[raw.trim().toLowerCase()];
			if (level && map[level] === null) map[level] = raw.trim();
		}
	}
	if (!map || !Object.values(map).some(value => value !== null)) return undefined;
	if (info.alwaysThinking) map.off = null;
	return Object.values(map).some(value => value !== null) ? map : undefined;
}

export function supportedThinkingLevels(info: ModelProbeInfo): ThinkingLevel[] | undefined {
	if (info.reasoning === false) return ["off"];
	const map = thinkingMap(info);
	return map ? PI_THINKING_LEVELS.filter(level => map[level] !== null) : undefined;
}

// Strip legacy defaults before resolving: absence must remain distinguishable
// from an explicit false. Only concrete values enter this module's result.
export function knownMetadata(info: ModelProbeInfo | undefined): ModelProbeInfo {
	if (!info) return {};
	const out: ModelProbeInfo = {};
	for (const field of CAPABILITY_FIELDS) {
		if (field !== "thinkingLevelMap" && info.defaultedFields?.includes(field as any)) continue;
		if (info[field] !== undefined) (out as any)[field] = info[field];
	}
	if (info.effortOptions?.length) out.effortOptions = [...info.effortOptions];
	if (info.endpointTypes?.length) out.endpointTypes = [...info.endpointTypes];
	const map = thinkingMap(out);
	if (map) { out.thinkingLevelMap = map; out.reasoning ??= true; }
	else delete out.thinkingLevelMap;
	return out;
}

export function resolveCapabilities(id: string, candidates: MetadataCandidate[]): ModelProbeInfo {
	const rule = knownMetadata(applyKnownModelFallback(id, undefined));
	const entries = [...candidates, { source: "local rules" as const, label: "local rules", info: rule }]
		.map(candidate => ({ ...candidate, info: knownMetadata(candidate.info) }));
	const out: ModelProbeInfo = { sources: {}, candidates: entries.filter(candidate => Object.keys(candidate.info).length > 0) };
	for (const field of CAPABILITY_FIELDS) {
		for (const candidate of entries) {
			const value = candidate.info[field];
			if (value === undefined) continue;
			(out as any)[field] = value;
			out.sources![field] = candidate.label;
			break;
		}
	}
	const thinking = entries.find(candidate => thinkingMap(candidate.info));
	if (out.reasoning === false) {
		delete out.thinkingLevelMap;
		delete out.alwaysThinking;
		delete out.sources!.thinkingLevelMap;
	} else if (thinking) {
		const always = entries.slice(0, entries.indexOf(thinking) + 1).find(candidate => candidate.info.alwaysThinking !== undefined)?.info.alwaysThinking;
		if (always !== undefined) out.alwaysThinking = always;
		else delete out.alwaysThinking;
		out.thinkingLevelMap = thinkingMap({ ...thinking.info, alwaysThinking: always });
		out.sources!.thinkingLevelMap = thinking.label;
		out.reasoning ??= true;
		out.sources!.reasoning ??= thinking.label;
	}
	return out;
}

// Compatibility-shaped entry point used by config builders. No guessed API
// defaults are represented as detected capabilities.
export function resolveModelInfo(id: string, info?: ModelProbeInfo, modelsDev?: Map<string, ModelProbeInfo>, _api?: string): ModelProbeInfo {
	if (info?.sources) return info;
	const candidates: MetadataCandidate[] = [];
	if (info) candidates.push({ source: "gateway", label: "gateway", info });
	const catalog = modelsDev?.get(id);
	if (catalog) candidates.push({ source: "models.dev", label: "models.dev", info: catalog });
	return resolveCapabilities(id, candidates);
}

export function modelInfoFromEntry(model: any): ModelProbeInfo {
	const info: ModelProbeInfo = {};
	if (typeof model?.name === "string" && model.name.trim() && model.name.trim() !== model.id) info.name = model.name.trim();
	if (typeof model?.contextWindow === "number" && model.contextWindow > 0) info.contextWindow = model.contextWindow;
	if (typeof model?.maxTokens === "number" && model.maxTokens > 0) info.maxTokens = model.maxTokens;
	if (Array.isArray(model?.input)) info.image = model.input.includes("image");
	if (typeof model?.reasoning === "boolean") info.reasoning = model.reasoning;
	if (info.reasoning) {
		const map = model.thinkingLevelMap ?? {};
		info.thinkingLevelMap = Object.fromEntries(PI_THINKING_LEVELS.map(level => [level,
			map[level] === null || ((level === "xhigh" || level === "max") && map[level] === undefined) ? null : map[level] ?? level,
		]));
	}
	if (model?.cost) info.cost = model.cost;
	return info;
}

export function matchingModelId(a: string, b: string): boolean {
	const candidates = (id: string) => normalizeModelIdCandidates(id).map(value => value.split("/").pop()!.toLowerCase());
	const target = new Set(candidates(a));
	return candidates(b).some(id => target.has(id));
}

export function describeCapabilities(info: ModelProbeInfo | undefined): string {
	const field = (key: CapabilityField, text: string) => `${text}${info?.sources?.[key] ? ` [${info.sources[key]}]` : ""}`;
	const parts = [field("image", `image: ${info?.image === undefined ? "unknown" : info.image ? "on" : "off"}`)];
	const levels = info ? supportedThinkingLevels(info) : undefined;
	parts.push(field("thinkingLevelMap", info?.reasoning === false ? "reasoning: off" : levels ? `thinking: ${levels.join(" / ")}` : `thinking levels: unknown${info?.reasoning === true ? " (reasoning supported)" : ""}`));
	parts.push(field("contextWindow", `context: ${info?.contextWindow ?? "unknown"}`));
	parts.push(field("maxTokens", `max-out: ${info?.maxTokens ?? "unknown"}`));
	return parts.join(" • ");
}
