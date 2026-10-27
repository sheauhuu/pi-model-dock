import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { sandbox } from "./helpers.mjs";

const gpt = "gpt-6.1-sol";
const glm = "glm-5.3";
const map = { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" };
const rawGpt = {
	id: gpt,
	context_length: 1050000,
	max_output_tokens: 128000,
	modalities: { input: ["text", "image", "pdf"] },
	capabilities: { vision: true, reasoning: true },
};
const storedModel = (id) => ({
	id,
	input: ["text"],
	reasoning: true,
	thinkingLevelMap: { xhigh: "xhigh" },
	contextWindow: 1050000,
	maxTokens: 128000,
	headers: { "x-model": "keep" },
});
const provider = (model) => ({ baseUrl: "https://gateway.invalid/v1", api: "openai-completions", models: [model] });
const credential = { type: "api_key", key: "test-only-key" };
const candidate = (info, source = "gateway") => ({ source, label: source, info });

test("gateway meta token aliases are read without overriding top-level limits", async () => {
	const s = await sandbox();
	const meta = { max_input_tokens: 272000, max_tokens: 32000 };
	assert.deepEqual(s.gateway.parseGatewayModel({ id: "custom", meta }), { contextWindow: 272000, maxTokens: 32000 });
	assert.deepEqual(s.gateway.parseGatewayModel({ id: "custom", context_window: 128000, max_output_tokens: 8192, meta }), { contextWindow: 128000, maxTokens: 8192 });
});

test("editing thinking levels leaves context config and preferences together unchanged", async () => {
	const s = await sandbox({
		providers: { aihub: provider({ ...storedModel(glm), contextWindow: 272000 }) },
		choices: ["aihub", "models", glm, "thinking-levels", "manual", ...endEdit],
		picks: ["low", "high", "max"],
	});
	s.store.writeModelState("aihub", glm, {
		metadata: { reasoning: true, contextWindow: 200000, sources: { contextWindow: "gateway" } },
		preferences: { contextWindow: 272000 },
	});
	await s.edit.editProviderFlow(s.ctx);
	assert.equal(s.state.config.providers.aihub.models[0].contextWindow, 272000);
	assert.equal(s.store.readModelState("aihub", glm).preferences.contextWindow, 272000);
	assert.deepEqual(s.state.config.providers.aihub.models[0].thinkingLevelMap, map);
	assert.ok(!s.state.selections.some(selection => selection.title === "Context window"));
});
const localGpt = {
	...storedModel(gpt),
	provider: "openai",
	api: "openai-responses",
	input: ["text", "image"],
	contextWindow: 272000,
	thinkingLevelMap: { ...map, medium: "medium", xhigh: "xhigh" },
};
const endEdit = ["back", null, "back", null];

test("AxonHub modalities.input and object capabilities are both parsed", async () => {
	const s = await sandbox();
	const info = s.gateway.parseGatewayModel(rawGpt);
	assert.equal(info.image, true);
	assert.equal(info.reasoning, true);
	assert.equal(info.contextWindow, 1050000);
	assert.equal(info.effortOptions, undefined);
});

test("Magpie string and object effort lists produce exactly Low/High/Max", async () => {
	const s = await sandbox();
	for (const values of [
		{ reasoning_levels: ["low", "high", "max"] },
		{ supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "max" }] },
	]) {
		const info = s.gateway.parseGatewayModel({ modalities: { input: ["text", "image"] }, reasoning: true, ...values });
		assert.equal(info.image, true);
		assert.deepEqual(s.cap.thinkingMap(info), map);
	}
});

test("unknown capabilities remain absent, distinct from explicit false", async () => {
	const s = await sandbox();
	assert.deepEqual(s.gateway.parseGatewayModel({ id: "unknown" }), {});
	assert.equal(s.gateway.parseGatewayModel({ capabilities: { vision: false, reasoning: false } }).image, false);
	const info = s.cap.resolveCapabilities("unknown", []);
	assert.equal(info.image, undefined);
	assert.equal(info.reasoning, undefined);
	assert.match(s.cap.describeCapabilities(info), /image: unknown/);
	assert.match(s.cap.describeCapabilities(info), /thinking levels: unknown/);
});

test("gateway false wins over positive catalog and rule guesses", async () => {
	const s = await sandbox();
	const info = s.cap.resolveCapabilities("deepseek-test", [
		candidate({ image: false, reasoning: false }),
		candidate({ image: true, reasoning: true, effortOptions: ["low", "high", "max"] }, "models.dev"),
	]);
	assert.equal(info.image, false);
	assert.equal(info.reasoning, false);
	assert.equal(info.thinkingLevelMap, undefined);
	assert.equal(info.sources.image, "gateway");
});

test("known gateway image true overrides an outdated negative family rule", async () => {
	const s = await sandbox();
	assert.equal(s.cap.resolveCapabilities("deepseek-test", [candidate({ image: true })]).image, true);
});

test("legacy default-filled booleans do not masquerade as detected metadata", async () => {
	const s = await sandbox();
	const info = s.cap.resolveCapabilities("unknown", [
		candidate({ image: false, reasoning: true, defaultedFields: ["image", "reasoning"] }),
		candidate({ image: true }, "models.dev"),
	]);
	assert.equal(info.image, true);
	assert.equal(info.reasoning, undefined);
	assert.equal(info.sources.image, "models.dev");
});

test("each field is filled independently with its own source", async () => {
	const s = await sandbox();
	const info = s.cap.resolveCapabilities(gpt, [
		candidate({ contextWindow: 1050000 }),
		candidate({ image: true }, "models.dev"),
		candidate({ maxTokens: 128000, reasoning: true, thinkingLevelMap: map }, "local catalog"),
	]);
	assert.equal(info.contextWindow, 1050000);
	assert.equal(info.image, true);
	assert.equal(info.sources.image, "models.dev");
	assert.equal(info.sources.thinkingLevelMap, "local catalog");
	assert.deepEqual(s.cap.supportedThinkingLevels(info), ["low", "high", "max"]);
});

test("unsupported effort names stay unknown instead of disabling every level", async () => {
	const s = await sandbox();
	assert.equal(s.cap.thinkingMap({ reasoning: true, effortOptions: ["vendor-future-level"] }), undefined);
	assert.equal(s.cap.supportedThinkingLevels({ reasoning: true }), undefined);
});

test("local references exclude custom providers and preserve both 272K/1.05M choices", async () => {
	const s = await sandbox({
		providers: { aihub: provider(storedModel(gpt)) },
		localModels: [localGpt, { ...localGpt, provider: "aihub", contextWindow: 999999 }],
	});
	const info = await s.catalog.resolveModelMetadata(s.ctx, gpt, { contextWindow: 1050000 }, "openai-responses");
	assert.equal(info.contextWindow, 1050000);
	assert.equal(info.image, true);
	const choices = s.settings.contextPresets(info);
	assert.ok(choices.some((choice) => choice.value === 272000));
	assert.ok(choices.some((choice) => choice.value === 1050000));
	assert.ok(!choices.some((choice) => choice.value === 999999));
});

test("models.dev native makers and relay-decorated ids can fill missing levels", async () => {
	const s = await sandbox({
		catalogs: { zai: new Map([[glm, { image: false, reasoning: true, effortOptions: ["low", "high", "max"] }]]) },
	});
	const info = await s.catalog.resolveModelMetadata(s.ctx, `relay/${glm}`, {});
	assert.equal(info.image, false);
	assert.deepEqual(s.cap.supportedThinkingLevels(info), ["low", "high", "max"]);
	assert.match(info.sources.thinkingLevelMap, /models.dev: zai/);
});

test("gateway listing adapts the v1 path and never sends generation requests", async () => {
	const s = await sandbox({
		fetcher: async (url) =>
			String(url).endsWith("/v1/models") ? Response.json({ data: [rawGpt] }) : new Response("missing", { status: 404 }),
	});
	const result = await s.gateway.probeModels("https://gateway.invalid", "test-key");
	assert.equal(result.baseUrl, "https://gateway.invalid/v1");
	assert.equal(result.infoById.get(gpt).image, true);
	assert.deepEqual(
		s.state.requests.map((request) => request.method),
		["GET", "GET"],
	);
});

test("auth failures stop probing and do not expose response bodies", async () => {
	const s = await sandbox({ fetcher: async () => new Response("do-not-echo-secret", { status: 401 }) });
	await assert.rejects(
		s.gateway.probeModels("https://gateway.invalid/v1", "test-key"),
		(error) => error.message.includes("401") && !error.message.includes("do-not-echo-secret"),
	);
	assert.equal(s.state.requests.length, 1);
});

test("partial gateway-wide results no longer suppress per-model effort details", async () => {
	const s = await sandbox({
		gatewayWide: new Map([[glm, { contextWindow: 1000000 }]]),
		fetcher: async () =>
			Response.json({
				id: glm,
				capabilities: { reasoning: { type: "effort", effort_options: ["low", "high", "max"] } },
				modalities: { input: ["text"] },
			}),
	});
	const info = (
		await s.shared.collectProbedModelInfo(
			s.ctx,
			"openai",
			{ mode: "literal", value: "test-key" },
			"https://gateway.invalid/v1",
			[glm],
			new Map([[glm, { contextWindow: 1000000 }]]),
		)
	).get(glm);
	assert.equal(s.state.requests.length, 1);
	assert.deepEqual(s.cap.supportedThinkingLevels(info), ["low", "high", "max"]);
});

test("new entries write the exact complete map without extension metadata", async () => {
	const s = await sandbox();
	const info = s.cap.resolveCapabilities(glm, [candidate({ reasoning: true, effortOptions: ["low", "high", "max"] })]);
	const entry = s.entry.buildModelEntry(glm, s.entry.modelOptionsFromProbe(info));
	assert.deepEqual(entry.thinkingLevelMap, map);
	assert.equal(entry.metadata, undefined);
	assert.equal(entry.sources, undefined);
	assert.equal(entry.preferences, undefined);
});

test("unknown effort levels do not automatically invent xhigh/max", async () => {
	const s = await sandbox();
	const entry = s.entry.buildModelEntry("unknown", s.entry.modelOptionsFromProbe({ reasoning: true }));
	assert.equal(entry.thinkingLevelMap?.xhigh, undefined);
	assert.equal(entry.thinkingLevelMap?.max, undefined);
});

test("refresh detects a level-only change even when reasoning remains true", async () => {
	const s = await sandbox();
	const info = s.cap.resolveCapabilities(glm, [candidate({ reasoning: true, effortOptions: ["low", "high", "max"] })]);
	const entry = storedModel(glm);
	const changes = s.settings.diffModelCapabilities(entry, info);
	assert.ok(changes.some((change) => change.field === "thinkingLevelMap"));
	s.settings.applyMetaChanges(entry, info, changes);
	assert.deepEqual(entry.thinkingLevelMap, map);
	assert.deepEqual(entry.headers, { "x-model": "keep" });
});

test("legacy High ceiling does not restrict refreshed model capabilities", async () => {
 const s = await sandbox();
 const info = s.cap.resolveCapabilities(glm, [candidate({ reasoning: true, effortOptions: ["low", "high", "max"] })]);
 const entry = storedModel(glm);
 s.settings.applyModelCapabilities(entry, info, { reasoning: "high" });
 assert.deepEqual(entry.thinkingLevelMap, map);
});

test("manual context and max output survive refresh of other fields", async () => {
	const s = await sandbox();
	const entry = { ...storedModel(gpt), contextWindow: 272000, maxTokens: 32000 };
	const info = s.cap.resolveCapabilities(gpt, [
		candidate({ contextWindow: 1050000, maxTokens: 128000, image: true, reasoning: true, thinkingLevelMap: map }),
	]);
	const preferences = { contextWindow: 272000, maxTokens: 32000 };
	const changes = s.settings.diffModelCapabilities(entry, info, preferences);
	assert.ok(!changes.some((change) => change.field === "contextWindow" || change.field === "maxTokens"));
	s.settings.applyMetaChanges(entry, info, changes, preferences);
	assert.equal(entry.contextWindow, 272000);
	assert.equal(entry.maxTokens, 32000);
	assert.deepEqual(entry.input, ["text", "image"]);
});

test("clearing a context override remains cleared on later refresh", async () => {
	const s = await sandbox();
	const entry = storedModel(gpt);
	s.settings.applyModelCapabilities(entry, { contextWindow: 1050000 }, { contextWindow: null });
	assert.equal(entry.contextWindow, undefined);
});

test("context presets expose 272K directly and retain source labels", async () => {
	const s = await sandbox({ choices: ["272000"] });
	const metadata = s.cap.resolveCapabilities(gpt, [
		candidate({ contextWindow: 1050000 }),
		candidate({ contextWindow: 272000 }, "local catalog"),
	]);
	assert.deepEqual(await s.prompts.promptContextChoice(s.ctx, 1050000, metadata), { mode: "manual", value: 272000 });
	assert.ok(s.state.selections[0].items.find((item) => item.value === "272000").description.includes("local catalog"));
});



test("preferences and provenance persist across extension reloads separately from models.json", async () => {
	const first = await sandbox();
	first.store.writeModelState("aihub", gpt, {
		metadata: { image: true, sources: { image: "gateway" } },
		preferences: { contextWindow: 272000 },
	});
	const second = await sandbox({ stateDir: first.state.stateDir });
	assert.equal(second.store.readModelState("aihub", gpt).preferences.contextWindow, 272000);
	assert.deepEqual(second.state.config.providers, {});
});

test("corrupt preference files are rejected instead of silently losing manual choices", async () => {
	const s = await sandbox();
	writeFileSync(s.store.MODEL_STATE_PATH, "invalid JSON");
	assert.throws(() => s.store.readModelState("aihub", gpt));
});

test("provider rename/deletion migrates and removes saved model preferences", async () => {
	const s = await sandbox();
	s.store.writeModelState("old", gpt, { preferences: { contextWindow: 272000 } });
	s.store.renameProviderState("old", "new");
	assert.deepEqual(s.store.readModelState("old", gpt), {});
	assert.equal(s.store.readModelState("new", gpt).preferences.contextWindow, 272000);
	s.store.removeModelStates("new");
	assert.deepEqual(s.store.readModelState("new", gpt), {});
});

test("models.dev Refresh rewrites exact effort levels through the real edit flow", async () => {
	const s = await sandbox({
		providers: { aihub: provider(storedModel(glm)) },
		catalogs: { zai: new Map([[glm, { reasoning: true, effortOptions: ["low", "high", "max"] }]]) },
		choices: ["aihub", "models", glm, "refresh", "modelsdev", "0", ...endEdit],
	});
	await s.edit.editProviderFlow(s.ctx);
	assert.deepEqual(s.state.config.providers.aihub.models[0].thinkingLevelMap, map);
	assert.ok(s.state.confirmations.some((item) => item.text.includes("thinking low / high / max")));
	assert.match(s.store.readModelState("aihub", glm).metadata.sources.thinkingLevelMap, /models.dev: zai/);
});

test("cancelled Refresh leaves model config and preferences unchanged", async () => {
	const original = provider(storedModel(glm));
	const s = await sandbox({
		providers: { aihub: original },
		catalogs: { zai: new Map([[glm, { reasoning: true, effortOptions: ["low", "high", "max"] }]]) },
		confirm: false,
		choices: ["aihub", "models", glm, "refresh", "modelsdev", "0", ...endEdit],
	});
	await s.edit.editProviderFlow(s.ctx);
	assert.deepEqual(s.state.config.providers.aihub, original);
	assert.deepEqual(s.store.readModelState("aihub", glm), {});
});

test("Refresh restores full levels without asking for a legacy ceiling replacement", async () => {
 const s = await sandbox({ providers: { aihub: provider(storedModel(glm)) }, catalogs: { zai: new Map([[glm, { reasoning: true, effortOptions: ["low", "high", "max"] }]]) }, choices: ["aihub", "models", glm, "refresh", "modelsdev", "0", ...endEdit] });
 s.store.writeModelState("aihub", glm, { preferences: { reasoning: "xhigh" } });
 await s.edit.editProviderFlow(s.ctx);
 assert.deepEqual(s.state.config.providers.aihub.models[0].thinkingLevelMap, map);
 assert.equal(s.store.readModelState("aihub", glm).preferences.reasoning, undefined);
});

test("272K selection survives a gateway refresh that learns images and full levels", async () => {
	const s = await sandbox({
		providers: { aihub: provider(storedModel(gpt)) },
		auth: { aihub: credential },
		localModels: [localGpt],
		choices: ["aihub", "models", gpt, "context", "272000", "refresh", "endpoint", ...endEdit],
		fetcher: async (url) =>
			String(url).endsWith("/models")
				? Response.json({ data: [rawGpt] })
				: Response.json({ ...rawGpt, reasoning_levels: ["low", "medium", "high", "xhigh", "max"] }),
	});
	await s.edit.editProviderFlow(s.ctx);
	const model = s.state.config.providers.aihub.models[0];
	assert.equal(model.contextWindow, 272000);
	assert.deepEqual(model.input, ["text", "image"]);
	assert.equal(model.thinkingLevelMap.max, "max");
	assert.equal(s.store.readModelState("aihub", gpt).metadata.contextWindow, 1050000);
	assert.equal(s.store.readModelState("aihub", gpt).preferences.contextWindow, 272000);
});

test("Auto restores detected context and removes the manual lock", async () => {
	const s = await sandbox({
		providers: { aihub: provider({ ...storedModel(gpt), contextWindow: 272000 }) },
		choices: ["aihub", "models", gpt, "context", "auto", ...endEdit],
	});
	s.store.writeModelState("aihub", gpt, {
		metadata: { contextWindow: 1050000, sources: { contextWindow: "gateway" } },
		preferences: { contextWindow: 272000 },
	});
	await s.edit.editProviderFlow(s.ctx);
	assert.equal(s.state.config.providers.aihub.models[0].contextWindow, 1050000);
	assert.equal(s.store.readModelState("aihub", gpt).preferences.contextWindow, undefined);
});

test("provider re-probe also updates exact levels while keeping a manual context cap", async () => {
	const s = await sandbox({
		providers: { aihub: provider({ ...storedModel(glm), contextWindow: 272000 }) },
		auth: { aihub: credential },
		choices: ["aihub", "probe", "back", null],
		tri: (items) => new Map(items.map((item) => [item.value, "on"])),
		fetcher: async () =>
			Response.json({
				data: [
					{
						id: glm,
						context_length: 1000000,
						max_output_tokens: 131072,
						modalities: { input: ["text"] },
						reasoning: true,
						reasoning_levels: ["low", "high", "max"],
					},
				],
			}),
	});
	s.store.writeModelState("aihub", glm, { preferences: { contextWindow: 272000 } });
	await s.edit.editProviderFlow(s.ctx);
	assert.equal(s.state.config.providers.aihub.models[0].contextWindow, 272000);
	assert.deepEqual(s.state.config.providers.aihub.models[0].thinkingLevelMap, map);
});

test("sidecar contains no auth fields and model config contains no private metadata", async () => {
	const s = await sandbox({
		providers: { aihub: provider(storedModel(gpt)) },
		choices: ["aihub", "models", gpt, "context", "272000", ...endEdit],
		localModels: [localGpt],
	});
	await s.edit.editProviderFlow(s.ctx);
	const text = readFileSync(s.store.MODEL_STATE_PATH, "utf8");
	assert.ok(!text.includes("test-only-key"));
	assert.ok(!text.includes("baseUrl") && !text.includes("headers"));
	assert.equal(s.state.config.providers.aihub.models[0].metadata, undefined);
});

test("an explicit gateway Off option is not disabled by a lower-priority always-on reference", async () => {
	const s = await sandbox();
	const info = s.cap.resolveCapabilities("test", [
		candidate({ reasoning: true, effortOptions: ["none", "low", "high"] }),
		candidate({ reasoning: true, alwaysThinking: true }, "models.dev"),
	]);
	assert.deepEqual(s.cap.supportedThinkingLevels(info), ["off", "low", "high"]);
});

test("an always-on-only refresh disables Off without requiring a boolean change", async () => {
	const s = await sandbox();
	const entry = storedModel("test");
	const info = s.cap.resolveCapabilities("test", [candidate({ reasoning: true, alwaysThinking: true })]);
	const changes = s.settings.diffModelCapabilities(entry, info);
	assert.ok(changes.some((change) => change.field === "alwaysThinking"));
	s.settings.applyMetaChanges(entry, info, changes);
	assert.equal(entry.thinkingLevelMap.off, null);
});

test("unexpected null capability shapes remain unknown without crashing", async () => {
	const s = await sandbox();
	assert.equal(s.gateway.parseGatewayModel({ capabilities: { reasoning: null }, reasoning_options: {} }).reasoning, undefined);
});

test("per-token prices retain zero values and use stable per-million rates", async () => {
	const s = await sandbox();
	assert.deepEqual(s.gateway.parseGatewayModel({ pricing: { prompt: "0", completion: "0.00000044" } }).cost, {
		input: 0,
		output: 0.44,
		cacheRead: 0,
		cacheWrite: 0,
	});
});

test("a context-only refresh preserves an existing sparse supported map", async () => {
	const s = await sandbox();
	const info = s.cap.resolveCapabilities(glm, [candidate({ contextWindow: 1000000, reasoning: true, thinkingLevelMap: map })]);
	const entry = { ...storedModel(glm), contextWindow: 272000, thinkingLevelMap: { ...map, max: null } };
	s.settings.applyMetaChanges(entry, info, [{ field: "contextWindow", label: "context" }], { reasoning: "high" });
	assert.deepEqual(entry.thinkingLevelMap, { ...map, max: null });
});

test("a manually entered unknown model remains unknown in saved metadata", async () => {
	const s = await sandbox({ choices: ["done"], inputs: ["unknown-model", ""] });
	const models = await s.prompts.promptManualModels(s.ctx, "openai");
	assert.equal(models.options.get("unknown-model").metadata.image, undefined);
	assert.equal(models.options.get("unknown-model").metadata.reasoning, undefined);
	assert.equal(models.options.get("unknown-model").contextWindow, undefined);
});

test("deleting a model removes its preference record but keeps other model records", async () => {
	const s = await sandbox({ providers: { aihub: provider(storedModel(gpt)) }, choices: ["aihub", "models", gpt, "delete", "back", null] });
	s.store.writeModelState("aihub", gpt, { preferences: { contextWindow: 272000 } });
	s.store.writeModelState("other", glm, { preferences: { contextWindow: 272000 } });
	await s.edit.editProviderFlow(s.ctx);
	assert.deepEqual(s.store.readModelState("aihub", gpt), {});
	assert.equal(s.store.readModelState("other", glm).preferences.contextWindow, 272000);
});

test("refresh detects disabled basic levels even when the highest level is unchanged", async () => {
	const s = await sandbox();
	const entry = { id: "test", reasoning: true, thinkingLevelMap: { max: "max" } };
	const info = s.cap.resolveCapabilities("test", [candidate({ reasoning: true, thinkingLevelMap: { ...map, medium: "medium" } })]);
	const changes = s.settings.diffModelCapabilities(entry, info);
	assert.ok(changes.some((change) => change.field === "thinkingLevelMap"));
	s.settings.applyMetaChanges(entry, info, changes);
	assert.equal(entry.thinkingLevelMap.off, null);
	assert.equal(entry.thinkingLevelMap.minimal, null);
});

test("reading an exact Off-only map reports Off", async () => {
	const s = await sandbox();
	assert.deepEqual(
		s.cap.supportedThinkingLevels(s.cap.modelInfoFromEntry({
			reasoning: true,
			thinkingLevelMap: { ...Object.fromEntries(Object.keys(map).map((level) => [level, null])), off: "none" },
		})),
		["off"],
	);
});
