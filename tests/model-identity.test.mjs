import assert from "node:assert/strict";
import test from "node:test";
import { sandbox } from "./helpers.mjs";

const id = "Custom/Model-5.3";
const complete = { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" };
const model = { id, input: ["text"], reasoning: true, thinkingLevelMap: { xhigh: "xhigh" }, contextWindow: 272000, maxTokens: 32000 };
const provider = (entry = model) => ({ baseUrl: "https://gateway.invalid/v1", api: "openai-completions", models: [entry] });
const end = ["back", null, "back", null];

test("manual declarations create a complete map and preserve provider aliases", async () => {
	const s = await sandbox();
	assert.deepEqual(s.settings.manualThinkingMap(["low", "high", "max"]), complete);
	assert.equal(s.settings.manualThinkingMap(["off", "xhigh"], { reasoning: true, effortOptions: ["none", "extended"] }).xhigh, "extended");
	assert.throws(() => s.settings.manualThinkingMap([]));
	assert.throws(() => s.settings.manualThinkingMap(["not-a-level"]));
});

test("unknown supported levels are initially unchecked and cancellation remains cancellation", async () => {
	const s = await sandbox({ choices: ["manual"], picks: null });
	assert.equal(await s.prompts.promptSupportedThinkingLevels(s.ctx, {}), null);
	assert.deepEqual(s.state.selections[1].options.initialValues, []);
	assert.equal(s.state.selections[1].options.itemLabel, "thinking level");
});

test("checkboxes preselect the current supported set", async () => {
	const s = await sandbox({ choices: ["manual"], picks: ["low", "high", "max"] });
	const result = await s.prompts.promptSupportedThinkingLevels(s.ctx, { reasoning: true, thinkingLevelMap: complete });
	assert.deepEqual(result.map, complete);
	assert.deepEqual(s.state.selections[1].options.initialValues, ["low", "high", "max"]);
});

test("manual declarations override observations without changing their recorded source", async () => {
	const s = await sandbox();
	const observed = { reasoning: false, sources: { reasoning: "gateway" } };
	const effective = s.settings.effectiveModelInfo(observed, { thinkingLevelMap: complete });
	assert.deepEqual(s.cap.supportedThinkingLevels(effective), ["low", "high", "max"]);
	assert.equal(effective.sources.thinkingLevelMap, "manual");
	assert.equal(observed.reasoning, false);
	assert.equal(observed.sources.reasoning, "gateway");
});

test("legacy ceiling preferences no longer restrict manually supported levels", async () => {
 const s = await sandbox();
 const preferences = { thinkingLevelMap: complete, reasoning: "high", reasoningValue: "custom" };
 const entry = { ...model };
 s.settings.applyPreferences(entry, preferences, {});
 assert.deepEqual(entry.thinkingLevelMap, complete);
 s.store.writeModelState("custom", id, { preferences });
 assert.deepEqual(s.store.readModelState("custom", id).preferences, { thinkingLevelMap: complete });
});

test("unknown model edit writes selected supported levels without changing the id", async () => {
	const s = await sandbox({
		providers: { custom: provider() },
		choices: ["custom", "models", id, "thinking-levels", "manual", ...end],
		picks: ["low", "high", "max"],
	});
	await s.edit.editProviderFlow(s.ctx);
	assert.deepEqual(s.state.config.providers.custom.models[0].thinkingLevelMap, complete);
	assert.equal(s.state.config.providers.custom.models[0].id, id);
	assert.deepEqual(s.store.readModelState("custom", id).preferences.thinkingLevelMap, complete);
	assert.equal(s.store.readModelState("custom", id).metadata.thinkingLevelMap, undefined);
});

test("cancelled checkbox editing does not write model or preference files", async () => {
	const s = await sandbox({
		providers: { custom: provider() },
		choices: ["custom", "models", id, "thinking-levels", "manual", ...end],
		picks: null,
	});
	await s.edit.editProviderFlow(s.ctx);
	assert.equal(s.state.saves, 0);
	assert.deepEqual(s.store.readModelState("custom", id), {});
});

test("supported level editing has no ceiling entry or replacement prompt", async () => {
 const s = await sandbox({ providers: { custom: provider() }, choices: ["custom", "models", id, "thinking-levels", "manual", ...end], picks: ["low", "high", "max"] });
 s.store.writeModelState("custom", id, { preferences: { reasoning: "medium" } });
 await s.edit.editProviderFlow(s.ctx);
 assert.deepEqual(s.state.config.providers.custom.models[0].thinkingLevelMap, complete);
 assert.equal(s.store.readModelState("custom", id).preferences.reasoning, undefined);
 assert.ok(!s.state.selections.some(selection => selection.title === "Reasoning ceiling" || selection.items?.some(item => item.value === "reasoning")));
});


test("manual supported sets survive Refresh while automatic observations keep updating", async () => {
	const configured = { ...model, thinkingLevelMap: complete };
	const s = await sandbox({
		providers: { custom: provider(configured) },
		catalogs: { openai: new Map([[id, { reasoning: true, effortOptions: ["minimal", "medium", "high"] }]]) },
		choices: ["custom", "models", id, "refresh", "modelsdev", "0", ...end],
	});
	s.store.writeModelState("custom", id, { preferences: { thinkingLevelMap: complete } });
	await s.edit.editProviderFlow(s.ctx);
	assert.deepEqual(s.state.config.providers.custom.models[0].thinkingLevelMap, complete);
	const state = s.store.readModelState("custom", id);
	assert.deepEqual(s.cap.supportedThinkingLevels(state.metadata), ["minimal", "medium", "high"]);
	assert.deepEqual(s.cap.supportedThinkingLevels(s.settings.effectiveModelInfo(state.metadata, state.preferences)), ["low", "high", "max"]);
});

test("Auto discards a manual declaration and restores observed supported levels", async () => {
	const automatic = { reasoning: true, effortOptions: ["low", "medium"] };
	const s = await sandbox({
		providers: { custom: provider({ ...model, thinkingLevelMap: complete }) },
		choices: ["custom", "models", id, "thinking-levels", "auto", ...end],
	});
	s.store.writeModelState("custom", id, { metadata: automatic, preferences: { thinkingLevelMap: complete } });
	await s.edit.editProviderFlow(s.ctx);
	assert.deepEqual(s.state.config.providers.custom.models[0].thinkingLevelMap, s.cap.thinkingMap(automatic));
	assert.equal(s.store.readModelState("custom", id).preferences.thinkingLevelMap, undefined);
});

test("an Off-only declaration disables reasoning and keeps Off as the only choice", async () => {
	const s = await sandbox({
		providers: { custom: provider() },
		choices: ["custom", "models", id, "thinking-levels", "manual", ...end],
		picks: ["off"],
	});
	await s.edit.editProviderFlow(s.ctx);
	assert.equal(s.state.config.providers.custom.models[0].reasoning, false);
	const state = s.store.readModelState("custom", id);
	assert.deepEqual(s.cap.supportedThinkingLevels(s.settings.effectiveModelInfo(state.metadata, state.preferences)), ["off"]);
});

test("manual addition supports checkbox declarations and a custom display name", async () => {
	const s = await sandbox({
		choices: ["custom", "openai", "literal", "Add manually", "thinking-levels", "manual", "name", "custom", "done"],
		inputs: ["https://gateway.invalid/v1", "MyHub", "test-key", id, "Custom Model 5.3", ""],
		picks: ["low", "high", "max"],
	});
	await s.add.addProviderFlow(s.ctx);
	const entry = s.state.config.providers.myhub.models[0];
	assert.equal(entry.id, id);
	assert.equal(entry.name, "Custom Model 5.3");
	assert.deepEqual(entry.thinkingLevelMap, complete);
	assert.equal(s.store.readModelState("myhub", id).preferences.name, "Custom Model 5.3");
});

test("gateway names support OpenAI, Magpie and Gemini without reusing Gemini resource ids", async () => {
	const s = await sandbox();
	assert.equal(s.gateway.parseGatewayModel({ id, name: "Custom Model" }).name, "Custom Model");
	assert.equal(s.gateway.parseGatewayModel({ id, display_name: "Magpie Model", name: "fallback" }).name, "Magpie Model");
	assert.equal(s.gateway.parseGatewayModel({ name: "models/Gemini-Case", displayName: "Gemini Name" }).name, "Gemini Name");
	assert.equal(s.gateway.parseGatewayModel({ name: "models/Gemini-Case" }).name, undefined);
});

test("models.dev names and capabilities share one concurrent catalog request", async () => {
	const s = await sandbox({
		catalogs: { openai: new Map([[id, { reasoning: true, contextWindow: 272000, image: true, effortOptions: ["low", "high", "max"] }]]) },
		catalogNames: { openai: { models: { [id]: { name: "GPT-6.1-Sol" } } } },
	});
	const [providers, models, options, info] = await Promise.all([
		s.catalog.fetchModelsDevProviders(), s.catalog.fetchModelsDevModels("openai"),
		s.catalog.fetchModelsDevOptionsForModel(id), s.catalog.resolveModelMetadata(s.ctx, id),
	]);
	assert.equal(info.name, "GPT-6.1-Sol");
	assert.match(info.sources.name, /models.dev: openai/);
	assert.equal(info.contextWindow, 272000);
	assert.equal(info.image, true);
	assert.deepEqual(s.cap.supportedThinkingLevels(info), ["low", "high", "max"]);
	assert.equal(providers.get("openai").baseUrl, "https://catalog.invalid/v1");
	assert.equal(options[0].info, models.get(id));
	assert.equal(s.state.catalogRequests, 1);
});

test("offline models.dev lookup uses one bundled catalog for names and capabilities", async () => {
	const s = await sandbox({ catalogOffline: true, catalogs: { openai: new Map([[id, { name: "Offline Name", image: true, contextWindow: 272000 }]]) } });
	const info = await s.catalog.resolveModelMetadata(s.ctx, id);
	assert.equal(info.name, "Offline Name");
	assert.equal(info.image, true);
	assert.equal(info.contextWindow, 272000);
	assert.equal((await s.catalog.fetchModelsDevModels("openai")).get(id).name, "Offline Name");
	assert.equal(s.state.catalogRequests, 1);
});

test("gateway names win over catalog names, with a local name fallback when catalogs miss", async () => {
	const s = await sandbox({
		catalogs: { openai: new Map([[id, { name: "Catalog Name" }]]) },
		localModels: [{ ...model, provider: "openai", name: "Local Name" }],
	});
	assert.equal((await s.catalog.resolveModelMetadata(s.ctx, id, { name: "Gateway Name" })).name, "Gateway Name");
	const offline = await sandbox({ localModels: [{ ...model, provider: "openai", name: "Local Name" }] });
	assert.equal((await offline.catalog.resolveModelMetadata(offline.ctx, id)).name, "Local Name");
});

test("model builders write display names without changing mixed-case API ids", async () => {
	const s = await sandbox();
	const entry = s.entry.buildModelEntry(id, { reasoning: "off", image: false, name: "GPT-6.1-Sol" });
	assert.equal(entry.id, id);
	assert.equal(entry.name, "GPT-6.1-Sol");
	assert.equal(s.entry.buildModelEntry(id, { reasoning: "off", image: false, name: id }).name, undefined);
});

test("pickers display and search by model name while their values remain API ids", async () => {
	const s = await sandbox();
	const entry = { ...model, name: "GPT-6.1-Sol" };
	const item = s.shared.providerModelItems(provider(entry))[0];
	assert.equal(item.value, id);
	assert.ok(item.label.includes("GPT-6.1-Sol") && item.label.includes(id));
	assert.ok(item.searchText.includes("GPT-6.1-Sol"));
	assert.ok(s.shared.probePickerItems([id], new Map([[id, { name: "GPT-6.1-Sol" }]]))[0].label.includes("GPT-6.1-Sol"));
});

test("editing a display name preserves id, model fields and credentials", async () => {
	const original = { ...model, headers: { "x-model": "keep" } };
	const s = await sandbox({
		providers: { custom: provider(original) },
		auth: { custom: { type: "api_key", key: "test-key" } },
		choices: ["custom", "models", id, "name", "custom", ...end],
		inputs: [" GPT-6.1-Sol "],
	});
	await s.edit.editProviderFlow(s.ctx);
	assert.deepEqual(s.state.config.providers.custom.models[0], { ...original, name: "GPT-6.1-Sol" });
	assert.deepEqual(s.state.keyRenames, []);
	assert.equal(s.store.readModelState("custom", id).preferences.name, "GPT-6.1-Sol");
});

test("display names are editable on legacy string model entries", async () => {
	const s = await sandbox({
		providers: { custom: provider(id) },
		choices: ["custom", "models", id, "name", "custom", ...end],
		inputs: ["Friendly Name"],
	});
	await s.edit.editProviderFlow(s.ctx);
	assert.equal(s.state.config.providers.custom.models[0].id, id);
	assert.equal(s.state.config.providers.custom.models[0].name, "Friendly Name");
});

test("manual display names survive refreshed reference names", async () => {
	const s = await sandbox({
		providers: { custom: provider({ ...model, name: "My Name" }) },
		catalogs: { openai: new Map([[id, { name: "Reference Name", image: true }]]) },
		choices: ["custom", "models", id, "refresh", "modelsdev", "0", ...end],
	});
	s.store.writeModelState("custom", id, { preferences: { name: "My Name" } });
	await s.edit.editProviderFlow(s.ctx);
	assert.equal(s.state.config.providers.custom.models[0].name, "My Name");
	assert.equal(s.store.readModelState("custom", id).metadata.name, "Reference Name");
});

test("Auto name restores detected spelling and removes the name override", async () => {
	const s = await sandbox({
		providers: { custom: provider({ ...model, name: "My Name" }) },
		choices: ["custom", "models", id, "name", "auto", ...end],
	});
	s.store.writeModelState("custom", id, {
		metadata: { name: "Detected Name", sources: { name: "gateway" } },
		preferences: { name: "My Name" },
	});
	await s.edit.editProviderFlow(s.ctx);
	assert.equal(s.state.config.providers.custom.models[0].name, "Detected Name");
	assert.equal(s.store.readModelState("custom", id).preferences.name, undefined);
});

test("Use model id remains a persistent name choice and cancelled name input saves nothing", async () => {
	const s = await sandbox({
		providers: { custom: provider({ ...model, name: "Name" }) },
		choices: ["custom", "models", id, "name", "id", ...end],
	});
	await s.edit.editProviderFlow(s.ctx);
	assert.equal(s.state.config.providers.custom.models[0].name, undefined);
	assert.equal(s.store.readModelState("custom", id).preferences.name, null);
	const cancelled = await sandbox({
		providers: { custom: provider() },
		choices: ["custom", "models", id, "name", "custom", ...end],
		inputs: [undefined],
	});
	await cancelled.edit.editProviderFlow(cancelled.ctx);
	assert.equal(cancelled.state.saves, 0);
});
