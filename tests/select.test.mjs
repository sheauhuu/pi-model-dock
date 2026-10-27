import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { SourceTextModule, SyntheticModule } from "node:vm";
import test from "node:test";

async function selector(initialValues = []) {
	const source = stripTypeScriptTypes(readFileSync(new URL("../src/ui/select.ts", import.meta.url), "utf8"));
	const ui = new SourceTextModule(source);
	await ui.link(
		() =>
			new SyntheticModule(["Key", "matchesKey", "truncateToWidth"], function () {
				this.setExport("Key", { up: "UP", down: "DOWN", enter: "ENTER", escape: "ESC" });
				this.setExport("matchesKey", (data, key) => data === key);
				this.setExport("truncateToWidth", (line) => line);
			}),
	);
	await ui.evaluate();
	let component;
	let completed = false;
	const ctx = {
		ui: {
			custom: (factory) =>
				new Promise((resolve) => {
					component = factory({ requestRender() {} }, { fg: (_color, text) => text, bold: (text) => text }, {}, (value) => {
						completed = true;
						resolve(value);
					});
				}),
		},
	};
	const items = ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((value) => ({ value, label: value }));
	const result = ui.namespace.pickMany(ctx, "Supported thinking levels", items, { initialValues, itemLabel: "thinking level" });
	return { component, result, completed: () => completed };
}

test("checkbox component preselects known levels and ignores unavailable values", async () => {
	const s = await selector(["low", "high", "max", "ghost"]);
	assert.ok(s.component.render(100).some((line) => line.includes("[x] low")));
	s.component.handleInput("ENTER");
	assert.deepEqual(await s.result, ["low", "high", "max"]);
});

test("checkbox component toggles with Space and cancels with Escape", async () => {
	const s = await selector(["low", "high", "max"]);
	s.component.handleInput("DOWN");
	s.component.handleInput("DOWN");
	s.component.handleInput(" ");
	for (let i = 0; i < 4; i++) s.component.handleInput("DOWN");
	s.component.handleInput(" ");
	s.component.handleInput("ENTER");
	assert.deepEqual(await s.result, ["high"]);
	const cancelled = await selector(["low"]);
	cancelled.component.handleInput(" ");
	cancelled.component.handleInput("ESC");
	assert.equal(await cancelled.result, null);
});

test("checkbox component requires a selection and permits Off-only", async () => {
	const s = await selector();
	s.component.handleInput("ENTER");
	assert.equal(s.completed(), false);
	assert.ok(s.component.render(100).some((line) => line.includes("at least one thinking level")));
	s.component.handleInput(" ");
	s.component.handleInput("ENTER");
	assert.deepEqual(await s.result, ["off"]);
});
