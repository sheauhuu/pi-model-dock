import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MODELS_JSON_PATH } from "./config.ts";
import type { ModelState } from "./types.ts";

// Keep provenance/preferences outside the host's strict models.json schema.
export const MODEL_STATE_PATH = join(dirname(MODELS_JSON_PATH), "pi-model-dock.json");
type StateFile = { version: 1; models: Record<string, ModelState> };
const keyOf = (provider: string, model: string) => JSON.stringify([provider, model]);

function load(): StateFile {
	if (!existsSync(MODEL_STATE_PATH)) return { version: 1, models: {} };
	const state = JSON.parse(readFileSync(MODEL_STATE_PATH, "utf8"));
	if (state?.version !== 1 || !state.models || typeof state.models !== "object" || Array.isArray(state.models)) throw new Error("Invalid pi-model-dock preferences file; refusing to discard saved choices");
	return state;
}

function withoutLegacyCeiling(state: ModelState): ModelState {
	if (!state.preferences) return state;
	const preferences = { ...state.preferences } as Record<string, unknown>;
	delete preferences.reasoning;
	delete preferences.reasoningValue;
	return { ...state, preferences };
}

function save(state: StateFile) {
	mkdirSync(dirname(MODEL_STATE_PATH), { recursive: true });
	writeFileSync(MODEL_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

export function readModelState(provider: string, model: string): ModelState {
	const state = load().models[keyOf(provider, model)];
	if (state === undefined) return {};
	if (!state || typeof state !== "object" || Array.isArray(state) || (state.preferences !== undefined && (!state.preferences || typeof state.preferences !== "object" || Array.isArray(state.preferences)))) throw new Error("Invalid saved model preferences; refusing to discard manual choices");
	return withoutLegacyCeiling(state);
}

export function writeModelState(provider: string, model: string, state: ModelState) {
	const file = load();
	file.models[keyOf(provider, model)] = withoutLegacyCeiling(state);
	save(file);
}

export function removeModelStates(provider: string, retainedIds: string[] = []) {
	if (!existsSync(MODEL_STATE_PATH)) return;
	const file = load();
	const retained = new Set(retainedIds);
	for (const key of Object.keys(file.models)) {
		const [owner, model] = JSON.parse(key);
		if (owner === provider && !retained.has(model)) delete file.models[key];
	}
	save(file);
}

export function renameProviderState(oldId: string, newId: string) {
	if (oldId === newId || !existsSync(MODEL_STATE_PATH)) return;
	const file = load();
	for (const key of Object.keys(file.models)) {
		const [provider, model] = JSON.parse(key);
		if (provider !== oldId) continue;
		const next = keyOf(newId, model);
		if (file.models[next]) throw new Error("Saved model preferences already exist under the new provider id");
		file.models[next] = file.models[key];
		delete file.models[key];
	}
	save(file);
}
