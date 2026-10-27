import assert from "node:assert/strict";
import test from "node:test";
import { sandbox } from "./helpers.mjs";
const provider = {
	baseUrl: "https://example.invalid/v1",
	api: "openai-completions",
	headers: { "x-test": "retained" },
	compat: { supportsDeveloperRole: false },
	models: [
		{
			id: "model",
			input: ["text", "image"],
			reasoning: true,
			thinkingLevelMap: { low: "low", high: "high" },
			cost: { input: 1, output: 2 },
		},
	],
	customField: { retained: true },
};
const credential = { type: "api_key", key: "isolated-test-key" };
const customChoices = ["custom", "openai", "literal", "Add manually", "done"];
const customInputs = (name) => ["https://example.invalid/v1", name, "isolated-test-key", "model", ""];
await test("identity preserves spelling and trims whitespace", async () => {
	const { names } = await sandbox();
	assert.deepEqual(names.providerIdentity(" AxonHub "), { id: "axonhub", name: "AxonHub" });
	assert.deepEqual(names.providerIdentity("axonhub"), { id: "axonhub" });
	assert.deepEqual(names.providerIdentity("API Gateway"), { id: "api-gateway", name: "API Gateway" });
});
await test("custom endpoint add saves display name and lowercase credential id", async () => {
	const s = await sandbox({ choices: customChoices, inputs: customInputs(" AxonHub ") });
	await s.add.addProviderFlow(s.ctx);
	assert.deepEqual(Object.keys(s.state.config.providers), ["axonhub"]);
	assert.equal(s.state.config.providers.axonhub.name, "AxonHub");
	assert.deepEqual(s.state.keySaves, ["axonhub"]);
	assert.ok(s.state.notifications.some((n) => n.text.includes("AxonHub (axonhub)")));
});
await test("lowercase add omits redundant name", async () => {
	const s = await sandbox({ choices: customChoices, inputs: customInputs("axonhub") });
	await s.add.addProviderFlow(s.ctx);
	assert.ok(!Object.hasOwn(s.state.config.providers.axonhub, "name"));
});
await test("catalog add preserves name without changing model metadata", async () => {
	const s = await sandbox({ choices: ["catalog", "catalog-site", "literal"], inputs: ["AIHub", "isolated-test-key"] });
	await s.add.addProviderFlow(s.ctx);
	const p = s.state.config.providers.aihub;
	assert.equal(p.name, "AIHub");
	assert.deepEqual(p.models[0].input, ["text", "image"]);
	assert.equal(p.models[0].contextWindow, 128000);
	assert.deepEqual(s.state.keySaves, ["aihub"]);
});
await test("blank catalog name keeps suggested id without extra name", async () => {
	const s = await sandbox({ choices: ["catalog", "catalog-site", "none"], inputs: [""] });
	await s.add.addProviderFlow(s.ctx);
	assert.ok(!Object.hasOwn(s.state.config.providers["catalog-site"], "name"));
});
await test("duplicate ids ignore case and re-prompt without overwriting", async () => {
	const s = await sandbox({
		providers: { axonhub: provider },
		choices: customChoices,
		inputs: ["https://example.invalid/v1", "AxonHub", "AIHub", "isolated-test-key", "model", ""],
	});
	await s.add.addProviderFlow(s.ctx);
	assert.deepEqual(s.state.config.providers.axonhub, provider);
	assert.equal(s.state.config.providers.aihub.name, "AIHub");
	assert.ok(s.state.notifications.some((n) => n.level === "warning" && n.text.includes("already exists")));
});
await test("built-in collision keeps original spelling under suggested custom id", async () => {
	const s = await sandbox({ choices: ["custom", "openai", "rename", "literal", "Add manually", "done"], inputs: customInputs("DeepSeek") });
	await s.add.addProviderFlow(s.ctx);
	assert.equal(s.state.config.providers["deepseek-custom"].name, "DeepSeek");
	assert.deepEqual(s.state.keySaves, ["deepseek-custom"]);
});
await test("cancelling name entry creates neither provider nor credential", async () => {
	const s = await sandbox({ choices: ["custom", "openai"], inputs: ["https://example.invalid/v1", undefined] });
	await s.add.addProviderFlow(s.ctx);
	assert.equal(s.state.saves, 0);
	assert.deepEqual(s.state.auth, {});
});
await test("display lists show name and id and retain legacy fallback", async () => {
	const s = await sandbox();
	const label = s.shared.describeProviderInline("axonhub", { ...provider, name: "AxonHub" });
	assert.equal(label.label, "AxonHub (axonhub)");
	assert.ok(label.searchText.includes("AxonHub") && label.searchText.includes("axonhub"));
	assert.equal(s.shared.describeProviderInline("legacy", provider).label, "legacy");
	assert.ok(s.shared.describeProvider("axonhub", { ...provider, name: "AxonHub" }).startsWith("AxonHub (axonhub)\n"));
});
await test("case-only rename keeps provider order, all fields, and credentials", async () => {
	const s = await sandbox({
		providers: { before: { models: [] }, axonhub: provider, after: { models: [] } },
		auth: { axonhub: credential },
		choices: ["axonhub", "rename", "back", null],
		inputs: ["AxonHub"],
	});
	await s.edit.editProviderFlow(s.ctx);
	assert.deepEqual(Object.keys(s.state.config.providers), ["before", "axonhub", "after"]);
	assert.deepEqual(s.state.config.providers.axonhub, { ...provider, name: "AxonHub" });
	assert.deepEqual(s.state.auth, { axonhub: credential });
	assert.deepEqual(s.state.keyRenames, []);
	assert.equal(s.state.saves, 1);
	assert.ok(s.state.selections.some((v) => v.title === "Edit AxonHub (axonhub)"));
});
await test("lowercase rename clears display override without moving credentials", async () => {
	const s = await sandbox({
		providers: { axonhub: { ...provider, name: "AxonHub" } },
		auth: { axonhub: credential },
		choices: ["axonhub", "rename", "back", null],
		inputs: ["axonhub"],
	});
	await s.edit.editProviderFlow(s.ctx);
	assert.deepEqual(s.state.config.providers.axonhub, provider);
	assert.deepEqual(s.state.keyRenames, []);
});
await test("unchanged name does not write config or refresh", async () => {
	const s = await sandbox({
		providers: { axonhub: { ...provider, name: "AxonHub" } },
		choices: ["axonhub", "rename", "back", null],
		inputs: ["AxonHub"],
	});
	await s.edit.editProviderFlow(s.ctx);
	assert.equal(s.state.saves, 0);
	assert.equal(s.state.refreshes, 0);
});
await test("id-changing rename preserves data and migrates credentials once", async () => {
	const s = await sandbox({
		providers: { before: { models: [] }, axonhub: { ...provider, name: "AxonHub" }, after: { models: [] } },
		auth: { axonhub: credential },
		choices: ["axonhub", "rename", "back", null],
		inputs: ["AIHub"],
	});
	await s.edit.editProviderFlow(s.ctx);
	assert.deepEqual(Object.keys(s.state.config.providers), ["before", "aihub", "after"]);
	assert.deepEqual(s.state.config.providers.aihub, { ...provider, name: "AIHub" });
	assert.deepEqual(s.state.auth, { aihub: credential });
	assert.deepEqual(s.state.keyRenames, [["axonhub", "aihub"]]);
});
await test("rename to an existing id leaves both providers and credentials intact", async () => {
	const providers = { axonhub: provider, aihub: { ...provider, name: "AIHub" } };
	const auth = { axonhub: credential };
	const s = await sandbox({ providers, auth, choices: ["axonhub", "rename", "back", null], inputs: ["AIHUB"] });
	await s.edit.editProviderFlow(s.ctx);
	assert.deepEqual(s.state.config.providers, providers);
	assert.deepEqual(s.state.auth, auth);
	assert.equal(s.state.saves, 0);
});
await test("collision resolution back to current custom id still updates spelling", async () => {
	const s = await sandbox({
		providers: { "deepseek-custom": { ...provider, name: "deepseek" } },
		auth: { "deepseek-custom": credential },
		choices: ["deepseek-custom", "rename", "rename", "back", null],
		inputs: ["DeepSeek"],
	});
	await s.edit.editProviderFlow(s.ctx);
	assert.equal(s.state.config.providers["deepseek-custom"].name, "DeepSeek");
	assert.deepEqual(s.state.keyRenames, []);
});
await test("cancelled rename does not write or move credentials", async () => {
	const s = await sandbox({
		providers: { axonhub: provider },
		auth: { axonhub: credential },
		choices: ["axonhub", "rename", "back", null],
		inputs: [undefined],
	});
	await s.edit.editProviderFlow(s.ctx);
	assert.equal(s.state.saves, 0);
	assert.deepEqual(s.state.keyRenames, []);
});
await test("delete displays the name but removes credentials by id", async () => {
	const s = await sandbox({
		providers: { axonhub: { ...provider, name: "AxonHub" } },
		auth: { axonhub: credential },
		choices: ["axonhub"],
	});
	await s.del.deleteProviderFlow(s.ctx);
	assert.deepEqual(s.state.config.providers, {});
	assert.deepEqual(s.state.keyRemovals, ["axonhub"]);
	assert.ok(s.state.confirmations[0].text.includes("AxonHub (axonhub)"));
});
