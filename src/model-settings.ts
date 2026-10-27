import { CAPABILITY_FIELDS, knownMetadata, supportedThinkingLevels, thinkingMap } from "./capabilities.ts";
import { PI_THINKING_LEVELS } from "./types.ts";
import type { CapabilityField, ModelPreferences, ModelProbeInfo, ThinkingLevel } from "./types.ts";

export type MetaChange = { field: CapabilityField; label: string };

export function manualThinkingMap(levels: string[], reference?: ModelProbeInfo): Record<string, string | null> {
	if (!levels.length || levels.some(level => !PI_THINKING_LEVELS.includes(level as ThinkingLevel))) throw new Error("Select at least one valid thinking level");
	const selected = new Set(levels);
	const known = reference ? thinkingMap(reference) : undefined;
	return Object.fromEntries(PI_THINKING_LEVELS.map(level => [level, selected.has(level) ? known?.[level] ?? (level === "off" ? "none" : level) : null]));
}

// Manual declarations are separate from observations. Refresh can update the
// observed data without rewriting the user's supported set or display name.
export function effectiveModelInfo(info: ModelProbeInfo, preferences: ModelPreferences): ModelProbeInfo {
	const effective: ModelProbeInfo = { ...info, sources: { ...info.sources } };
	if (Object.hasOwn(preferences, "name")) { effective.name = preferences.name ?? undefined; effective.sources!.name = "manual"; }
	if (preferences.thinkingLevelMap !== undefined) {
		const map = thinkingMap({ thinkingLevelMap: preferences.thinkingLevelMap });
		if (!map) throw new Error("The manual supported thinking list must contain at least one valid level");
		effective.reasoning = PI_THINKING_LEVELS.some(level => level !== "off" && map[level] !== null);
		effective.thinkingLevelMap = map;
		effective.effortOptions = undefined;
		effective.alwaysThinking = effective.reasoning && map.off === null;
		effective.sources!.reasoning = "manual";
		effective.sources!.thinkingLevelMap = "manual";
	}
	return effective;
}

export function invalidContextPreference(info: ModelProbeInfo, preferences: ModelPreferences): boolean {
	return typeof preferences.contextWindow === "number" && info.contextWindow !== undefined && info.sources?.contextWindow === "gateway" && preferences.contextWindow > info.contextWindow;
}

export function applyPreferences(entry: any, preferences: ModelPreferences, info?: ModelProbeInfo) {
	if (Object.hasOwn(preferences, "name")) {
		if (preferences.name?.trim() && preferences.name.trim() !== entry.id) entry.name = preferences.name.trim();
		else delete entry.name;
	}
	for (const field of ["contextWindow", "maxTokens"] as const) {
		if (preferences[field] === null) delete entry[field];
		else if (preferences[field] !== undefined) entry[field] = preferences[field];
	}
	if (preferences.image !== undefined) entry.input = preferences.image ? ["text", "image"] : ["text"];
	const effective = effectiveModelInfo(info ?? {}, preferences);
	if (preferences.thinkingLevelMap !== undefined) {
		entry.reasoning = effective.reasoning;
		if (effective.reasoning) entry.thinkingLevelMap = thinkingMap(effective);
		else delete entry.thinkingLevelMap;
	}
}

export function applyModelCapabilities(entry: any, raw: ModelProbeInfo, preferences: ModelPreferences = {}) {
	const info = knownMetadata(raw);
	if (info.name?.trim() && info.name.trim() !== entry.id) entry.name = info.name.trim();
	for (const field of ["contextWindow", "maxTokens"] as const) if (info[field] !== undefined) entry[field] = info[field];
	if (info.image !== undefined) entry.input = info.image ? ["text", "image"] : ["text"];
	if (info.cost !== undefined) entry.cost = info.cost;
	if (info.reasoning !== undefined) entry.reasoning = info.reasoning;
	if (info.reasoning === false) delete entry.thinkingLevelMap;
	else {
		const map = thinkingMap(info);
		if (map) { entry.reasoning = true; entry.thinkingLevelMap = map; }
		else if (info.alwaysThinking && entry.reasoning) entry.thinkingLevelMap = { ...entry.thinkingLevelMap, off: null };
	}
	applyPreferences(entry, preferences, info);
}

function mapSignature(map: any): string {
	return JSON.stringify(PI_THINKING_LEVELS.map(level => [level, map?.[level] === undefined ? (level === "xhigh" || level === "max" ? null : level) : map[level]]));
}

export function diffModelCapabilities(model: any, info: ModelProbeInfo, preferences: ModelPreferences = {}): MetaChange[] {
	info = { ...knownMetadata(info), sources: info.sources };
	const effective = effectiveModelInfo(info, preferences);
	const next = structuredClone(typeof model === "object" && model ? model : {});
	const effectivePreferences = { ...preferences };
	if (invalidContextPreference(info, preferences)) delete effectivePreferences.contextWindow;
	applyModelCapabilities(next, info, effectivePreferences);
	const changes: MetaChange[] = [];
	for (const field of CAPABILITY_FIELDS) {
		if (info[field] === undefined || field === "video") continue;
		if (info.sources?.[field] === "local rules") continue;
		if (field === "alwaysThinking") {
			if (info.alwaysThinking && model?.thinkingLevelMap?.off !== null && next.thinkingLevelMap?.off === null) changes.push({ field, label: "reasoning always on (Off disabled)" });
		} else if (field === "image") {
			if (JSON.stringify(model?.input) !== JSON.stringify(next.input)) changes.push({ field, label: `image ${next.input?.includes("image") ? "on" : "off"}` });
		} else if (field === "thinkingLevelMap") {
			if (mapSignature(model?.thinkingLevelMap) !== mapSignature(next.thinkingLevelMap)) changes.push({ field, label: `thinking ${supportedThinkingLevels(effective)?.join(" / ") ?? "unknown"}` });
		} else if (field === "reasoning") {
			if ((model?.reasoning === true) !== (next.reasoning === true)) changes.push({ field, label: `reasoning ${next.reasoning ? "on" : "off"}` });
		} else if (JSON.stringify(model?.[field]) !== JSON.stringify(next[field])) {
			changes.push({ field, label: field === "cost" ? "cost updated" : `${field} ${model?.[field] ?? "unset"} → ${next[field] ?? "unset"}` });
		}
	}
	return changes;
}

// Apply exactly the reviewed fields, keeping unrelated model overrides.
export function applyMetaChanges(entry: any, info: ModelProbeInfo, changes: MetaChange[], preferences: ModelPreferences = {}) {
	info = knownMetadata(info);
	const selected: ModelProbeInfo = {};
	for (const { field } of changes) (selected as any)[field] = info[field];
	if (changes.some(change => change.field === "thinkingLevelMap")) { selected.reasoning = info.reasoning ?? true; selected.alwaysThinking = info.alwaysThinking; }
	applyModelCapabilities(entry, selected);
	applyPreferences(entry, preferences, info);
}

export function contextPresets(info: ModelProbeInfo | undefined, current?: number) {
	const values = new Map<number, Set<string>>();
	const add = (value: number | undefined, source: string) => {
		if (value === undefined || !Number.isFinite(value) || value <= 0) return;
		if (!values.has(value)) values.set(value, new Set());
		values.get(value)!.add(source);
	};
	add(info?.contextWindow, info?.sources?.contextWindow ?? "detected");
	for (const candidate of info?.candidates ?? []) add(candidate.info.contextWindow, candidate.label);
	add(current, "current setting");
	return [...values].map(([value, sources]) => ({ value, sources: [...sources] }));
}
