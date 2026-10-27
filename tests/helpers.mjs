import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { stripTypeScriptTypes } from "node:module";
import { SourceTextModule, SyntheticModule } from "node:vm";
import { after } from "node:test";
const root = fileURLToPath(new URL("..", import.meta.url));
const temporaryDirs = new Set();
const originalFetch = globalThis.fetch;
after(() => {
	globalThis.fetch = originalFetch;
	for (const path of temporaryDirs) rmSync(path, { recursive: true, force: true });
});
export async function sandbox({
	providers = {},
	auth = {},
	choices = [],
	inputs = [],
	picks = ["catalog-model"],
	confirm = true,
	localModels = [],
	catalogs = {},
	catalogNames,
	catalogOffline = false,
	gatewayWide = new Map(),
	fetcher,
	stateDir,
	tri,
} = {}) {
	stateDir ??= mkdtempSync(join(tmpdir(), "pi-model-dock-test-"));
	temporaryDirs.add(stateDir);
	const state = {
		stateDir,
		catalogRequests: 0,
		requests: [],
		config: { providers: structuredClone(providers) },
		auth: structuredClone(auth),
		choices: [...choices],
		inputs: [...inputs],
		selections: [],
		notifications: [],
		confirmations: [],
		saves: 0,
		keySaves: [],
		keyRenames: [],
		keyRemovals: [],
		refreshes: 0,
	};
	const select = {
		selectOne: async (ctx, title, items) => {
			state.selections.push({ title, items: structuredClone(items) });
			assert.ok(state.choices.length, `Unexpected selection: ${title}`);
			const choice = state.choices.shift();
			if (choice !== null)
				assert.ok(
					items.some((item) => (typeof item === "string" ? item : item.value) === choice),
					`Unavailable choice ${choice} in ${title}`,
				);
			return choice;
		},
		pickMany: async (_ctx, title, items, options) => {
			state.selections.push({ title, items: structuredClone(items), options: structuredClone(options) });
			const result = typeof picks === "function" ? picks(title, items, options) : picks;
			if (options?.itemLabel === "thinking level" && result !== null)
				assert.ok(result.every((value) => items.some((item) => item.value === value)));
			return result;
		},
		pickTriState: async (_ctx, _title, items) => {
			state.selections.push({ title: _title, items: structuredClone(items) });
			return tri ? tri(items) : new Map(items.map((item) => [item.value, item.initial]));
		},
	};
	const config = {
		BUILTIN_COLLISION_WARNING: "builtin collision",
		BUILTIN_PROVIDER_IDS: new Set(["deepseek"]),
		MODELS_JSON_PATH: join(stateDir, "models.json"),
		AUTH_JSON_PATH: join(stateDir, "auth.json"),
		SPLIT_AUTH: true,
		loadModelsConfig: () => structuredClone(state.config),
		saveModelsConfig: (c) => {
			state.config = structuredClone(c);
			state.saves++;
		},
		storedApiKey: (id) => state.auth[id]?.key,
		saveProviderApiKey: (id, key) => {
			state.auth[id] = { type: "api_key", key };
			state.keySaves.push(id);
		},
		renameProviderApiKey: (oldId, newId) => {
			state.auth[newId] = state.auth[oldId];
			delete state.auth[oldId];
			state.keyRenames.push([oldId, newId]);
		},
		removeProviderApiKey: (id) => {
			delete state.auth[id];
			state.keyRemovals.push(id);
		},
	};
	const tables = {
		"catalog-site": new Map([["catalog-model", { image: true, reasoning: false, contextWindow: 128000, maxTokens: 8192 }]]),
		...catalogs,
	};
	const rawCatalog = Object.fromEntries(Object.entries(tables).map(([providerId, table]) => [providerId, {
		id: providerId, name: providerId, api: "https://catalog.invalid/v1", env: [],
		models: Object.fromEntries([...table].map(([id, info]) => [id, {
			id, name: info.name, reasoning: info.reasoning,
			limit: { context: info.contextWindow, output: info.maxTokens },
			modalities: info.image === undefined && info.video === undefined ? undefined : { input: ["text", ...(info.image ? ["image"] : []), ...(info.video ? ["video"] : [])] },
			reasoning_options: info.effortOptions ? [{ type: "effort", values: info.effortOptions }] : undefined,
			cost: info.cost ? { input: info.cost.input, output: info.cost.output, cache_read: info.cost.cacheRead, cache_write: info.cost.cacheWrite } : undefined,
			...catalogNames?.[providerId]?.models?.[id],
		}])),
	}]));
	const probe = {
		PROBE_TIMEOUT_MS: 100,
		// Catalog fixtures already contain valid limits; dependency I/O stays stubbed.
		normalizeModelLimits: (contextWindow, maxTokens) => ({ contextWindow, maxTokens }),
		probeDeveloperRole: async () => false,
		probeInfoSummary: (info) => Object.keys(info ?? {}).filter((key) => ["image", "reasoning", "contextWindow", "maxTokens"].includes(key)),
		fetchGatewayWideInfo: async () => gatewayWide,
		fetchPerModelInfo: async () => new Map(),
		applyKnownModelFallback: (id, info) => (id.toLowerCase().includes("deepseek") ? { image: false, reasoning: true, ...info } : info),
		normalizeModelIdCandidates: (id) => [
			id,
			id.toLowerCase(),
			id
				.split("/")
				.pop()
				.toLowerCase()
				.split("@")[0]
				.replace(/\[1m\]$/, ""),
		],
	};
	globalThis.fetch = async (input, init = {}) => {
		state.requests.push({ url: String(input), method: init.method ?? "GET" });
		assert.equal(init.method ?? "GET", "GET", "No generation requests in tests");
		if (!fetcher) throw Error("Network access is disabled in isolated tests");
		return fetcher(input, init);
	};
	const ctx = {
		ui: {
			input: async () => {
				assert.ok(state.inputs.length, "Unexpected input");
				return state.inputs.shift();
			},
			notify: (text, level) => state.notifications.push({ text, level }),
			confirm: async (title, text) => {
				state.confirmations.push({ title, text });
				return confirm;
			},
		},
		modelRegistry: {
			getAll: () => localModels,
			refresh: () => {
				state.refreshes++;
			},
		},
	};
	const modules = new Map();
	const synthetic = (id, values) => {
		if (!modules.has(id))
			modules.set(
				id,
				new SyntheticModule(
					Object.keys(values),
					function () {
						for (const [k, v] of Object.entries(values)) this.setExport(k, v);
					},
					{ identifier: id },
				),
			);
		return modules.get(id);
	};
	async function getModule(id) {
		if (modules.has(id)) return modules.get(id);
		if (id === resolve(root, "src/config.ts")) return synthetic(id, config);
		if (id === resolve(root, "src/ui/select.ts")) return synthetic(id, select);
		if (id === "model-probe") return synthetic(id, probe);
		if (id === "@opencode-ai/models") return synthetic(id, { Models: { make: () => ({ providers: async () => { state.catalogRequests++; if (catalogOffline) throw new Error("Catalog offline"); return rawCatalog; } }) } });
		if (id === "@opencode-ai/models/snapshot") return synthetic(id, { providers: rawCatalog });
		if (id.startsWith("node:")) return synthetic(id, await import(id));
		const source = stripTypeScriptTypes(readFileSync(id, "utf8"));
		const module = new SourceTextModule(source, {
			identifier: id,
			importModuleDynamically: async (specifier, referencing) => {
				const target = await getModule(specifier.startsWith(".") ? resolve(dirname(referencing.identifier), specifier) : specifier);
				if (target.status === "unlinked") await target.link((child, parent) => getModule(child.startsWith(".") ? resolve(dirname(parent.identifier), child) : child));
				if (target.status === "linked") await target.evaluate();
				return target;
			},
		});
		modules.set(id, module);
		return module;
	}
	const entry = new SourceTextModule(
		[
			"prompts:src/ui/prompts.ts",
			"add:src/flows/add.ts",
			"edit:src/flows/edit.ts",
			"shared:src/flows/shared.ts",
			"names:src/provider-name.ts",
			"modelNames:src/model-name.ts",
			"del:src/flows/delete.ts",
			"cap:src/capabilities.ts",
			"gateway:src/gateway-metadata.ts",
			"catalog:src/model-catalog.ts",
			"settings:src/model-settings.ts",
			"store:src/model-state.ts",
			"entry:src/model-entry.ts",
		]
			.map((s) => {
				const [name, file] = s.split(":");
				return `export * as ${name} from ${JSON.stringify(resolve(root, file))};`;
			})
			.join("\n"),
		{ identifier: resolve(root, "__isolated_name_check__.mjs") },
	);
	await entry.link((specifier, referencing) =>
		getModule(specifier.startsWith(".") ? resolve(dirname(referencing.identifier), specifier) : specifier),
	);
	await entry.evaluate();
	return { state, ctx, ...entry.namespace };
}
