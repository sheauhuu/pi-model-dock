import { BUILTIN_COLLISION_WARNING, BUILTIN_PROVIDER_IDS, loadModelsConfig } from "../config.ts";
import { describeCapabilities, supportedThinkingLevels } from "../capabilities.ts";
import { resolveModelMetadata } from "../model-catalog.ts";
import { applyModelCapabilities, contextPresets, effectiveModelInfo, manualThinkingMap } from "../model-settings.ts";
import { modelOptionsFromProbe } from "../model-entry.ts";
import { REASONING_LEVELS } from "../types.ts";
import type { ApiKeyMode, CommandContext, ModelOptions, ModelPreferences, ModelProbeInfo, ProviderApi, ProviderIdentity, ProviderStyle, ThinkingLevel, SelectItem } from "../types.ts";
import { providerIdentity } from "../provider-name.ts";
import { normalizeEndpoint, suggestProviderId } from "../url.ts";
import { modelDisplayName, modelLabel } from "../model-name.ts";
import { pickMany, selectOne } from "./select.ts";

export async function promptApiKey(
	ctx: CommandContext,
): Promise<{ mode: ApiKeyMode; value?: string } | null> {
	const choice = await selectOne(ctx, "API key", [
		{ value: "literal", label: "API key", description: "Stored in auth.json, like pi's own /login credentials" },
		{ value: "none", label: "None", description: "No key; a placeholder is written so the provider still loads" },
	]);
	if (!choice) return null;
	if (choice === "none") return { mode: "none" };

	const value = await ctx.ui.input("API key", "saved in auth.json under the provider id");
	if (value === undefined) return null;
	const trimmed = value.trim();
	if (!trimmed) return { mode: "none" };
	return { mode: "literal", value: trimmed };
}

export type SupportedThinkingChoice = { mode: "auto" } | { mode: "manual"; map: Record<string, string | null> };

export async function promptSupportedThinkingLevels(ctx: CommandContext, metadata: ModelProbeInfo, preferences: ModelPreferences = {}): Promise<SupportedThinkingChoice | null> {
	const effective = effectiveModelInfo(metadata, preferences);
	const current = supportedThinkingLevels(effective);
	const mode = await selectOne(ctx, "Supported thinking levels", [
		{ value: "auto", label: "Auto", description: `Detected: ${supportedThinkingLevels(metadata)?.join(" / ") ?? "unknown"} [${metadata.sources?.thinkingLevelMap ?? metadata.sources?.reasoning ?? "unknown"}]` },
		{ value: "manual", label: "Manual • select supported levels", description: "Declare the levels your model supports; kept on refresh (not a live test)" },
	]);
	if (!mode) return null;
	if (mode === "auto") return { mode: "auto" };
	const labels: Record<ThinkingLevel, string> = { off: "Off", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "XHigh", max: "Max" };
	const selected = await pickMany(ctx, "Supported thinking levels • manual declaration", REASONING_LEVELS.map(level => ({ value: level, label: labels[level] })), { initialValues: current ?? [], itemLabel: "thinking level" });
	if (selected === null) return null;
	return { mode: "manual", map: manualThinkingMap(selected, effective) };
}

export type ModelNameChoice = { mode: "auto" } | { mode: "manual"; value: string | null };

export async function promptModelName(ctx: CommandContext, id: string, current: string, metadata: ModelProbeInfo): Promise<ModelNameChoice | null> {
	const mode = await selectOne(ctx, "Model display name", [
		{ value: "auto", label: `Auto • ${metadata.name ?? id}`, description: metadata.sources?.name ?? "No display name found; use the exact model id" },
		{ value: "custom", label: "Custom…", description: "Preserve your spelling; leave the API model id unchanged" },
		{ value: "id", label: `Use model id • ${id}`, description: "Keep displaying the id on refresh" },
	]);
	if (!mode) return null;
	if (mode === "auto") return { mode: "auto" };
	if (mode === "id") return { mode: "manual", value: null };
	const value = await ctx.ui.input("Model display name", `current: ${current} (blank = use model id)`);
	if (value === undefined) return null;
	return { mode: "manual", value: value.trim() && value.trim() !== id ? value.trim() : null };
}

export async function promptImageChoice(ctx: CommandContext, metadata: ModelProbeInfo) {
	const choice = await selectOne(ctx, "Image input", [
		{ value: "auto", label: `Auto • ${metadata.image === undefined ? "unknown (text only until known)" : metadata.image ? "on" : "off"}`, description: metadata.sources?.image },
		{ value: "yes", label: "On • manual", description: "Keep image input enabled on refresh" },
		{ value: "no", label: "Off • manual", description: "Keep text-only input on refresh" },
	]);
	return choice as "auto" | "yes" | "no" | null;
}

export type ContextChoice = { mode: "auto" } | { mode: "manual"; value: number | null };

export async function promptContextChoice(ctx: CommandContext, current?: number, metadata?: ModelProbeInfo): Promise<ContextChoice | null> {
	const format = (value: number) => value >= 1_000_000 && value % 1000 === 0 ? `${value / 1_000_000}M` : value % 1000 === 0 ? `${value / 1000}K` : String(value);
	const presets = contextPresets(metadata, current);
	for (const value of [128000, 272000, 1000000]) {
		if (!presets.some(preset => preset.value === value)) presets.push({ value, sources: ["usage limit preset"] });
	}
	const limit = metadata?.sources?.contextWindow === "gateway" ? metadata.contextWindow : undefined;
	const items: SelectItem[] = [
		{ value: "auto", label: `Auto • ${metadata?.contextWindow ? format(metadata.contextWindow) : "unknown"}`, description: metadata?.sources?.contextWindow ?? "Use Pi defaults until metadata is available" },
		...presets.filter(preset => !limit || preset.value <= limit).map(preset => ({ value: String(preset.value), label: `${format(preset.value)} (${preset.value} tokens)`, description: `${preset.sources.join(" / ")} • keep this limit on refresh` })),
		{ value: "custom", label: "Custom…", description: "Enter a token limit" },
	];
	const choice = await selectOne(ctx, "Context window", items);
	if (!choice) return null;
	if (choice === "auto") return { mode: "auto" };
	const value = choice === "custom" ? await promptContextWindow(ctx, current) : Number(choice);
	if (value === null) return null;
	if (limit && value > limit) { ctx.ui.notify(`The gateway declares a maximum of ${limit} tokens. Choose a limit at or below it.`, "warning"); return null; }
	return { mode: "manual", value: value === 0 ? null : value };
}

export async function promptImage(ctx: CommandContext, current?: boolean): Promise<boolean | null> {
	const choice = await selectOne(ctx, "Image input", [
		{ value: "yes", label: "Yes - send text + images", description: "Sets input: [text, image]" },
		{ value: "no", label: "No - text only", description: "Sets input: [text]" },
	], { initialIndex: current === false ? 1 : 0 });
	if (!choice) return null;
	return choice === "yes";
}

// Prompts for a context window size in tokens. Returns:
//   number  -> set/replace contextWindow
//   0       -> clear contextWindow (user typed 0)
//   null    -> cancelled, leave unchanged
export async function promptContextWindow(ctx: CommandContext, current?: number): Promise<number | null> {
	const value = await ctx.ui.input(
		"Context window (tokens)",
		current ? `current: ${current} (blank = keep, 0 = clear)` : "e.g. 128000 (blank = unset)",
	);
	if (value === undefined) return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	const parsed = Number(trimmed.replace(/[_,]/g, ""));
	if (!Number.isSafeInteger(parsed) || parsed < 0) {
		ctx.ui.notify("Enter a whole number of tokens (0 to clear).", "warning");
		return null;
	}
	return parsed;
}

// Prompts for max output tokens. Same return contract as promptContextWindow:
// number to set, 0 to clear, null to leave unchanged.
export async function promptMaxTokens(ctx: CommandContext, current?: number): Promise<number | null> {
	const value = await ctx.ui.input(
		"Max output tokens",
		current ? `current: ${current} (blank = keep, 0 = clear)` : "e.g. 8192 (blank = unset)",
	);
	if (value === undefined) return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	const parsed = Number.parseInt(trimmed.replace(/[_,]/g, ""), 10);
	if (!Number.isFinite(parsed) || parsed < 0) {
		ctx.ui.notify("Enter a whole number of tokens (0 to clear).", "warning");
		return null;
	}
	return parsed;
}

// Manual model entry: type an id, land in that model's metadata menu (each
// field opens its own prompt and returns to the menu), then the next id.
// Blank enter or esc on the id prompt exits. Starting values come from
// reference catalogs/rules; manual ids have no gateway probe data.
// Returns the ids plus every model's confirmed options; null when cancelled
// with nothing entered.
export async function promptManualModels(
	ctx: CommandContext,
	style: ProviderStyle,
): Promise<{ ids: string[]; options: Map<string, ModelOptions> } | null> {
	const placeholder =
		style === "anthropic"
			? "e.g. claude-sonnet-4-5 (blank or esc to finish)"
			: style === "ollama"
				? "e.g. llama3.1:8b or qwen2.5-coder:7b (blank or esc to finish)"
				: style === "gemini"
					? "e.g. gemini-2.5-pro (blank or esc to finish)"
					: "e.g. gpt-4o-mini or qwen/qwen3-coder (blank or esc to finish)";

	const ids: string[] = [];
	const options = new Map<string, ModelOptions>();
	while (true) {
		const value = await ctx.ui.input(ids.length === 0 ? "Model id" : "Add another model id", placeholder);
		if (value === undefined) break; // esc
		const id = value.trim();
		if (!id) break; // blank enter exits
		if (ids.includes(id)) {
			ctx.ui.notify(`Model already added: ${id}`, "warning");
			continue;
		}

		const api: ProviderApi =
			style === "anthropic"
				? "anthropic-messages"
				: style === "gemini"
					? "google-generative-ai"
					: style === "openai-responses"
						? "openai-responses"
						: "openai-completions";
		const resolved = await resolveModelMetadata(ctx, id, {}, api);
		const opts: ModelOptions = { ...modelOptionsFromProbe(resolved), preferences: {} };
		const summary = describeCapabilities(resolved);

		// Per-model menu: each field opens its own prompt, then comes back here.
		while (true) {
			const effective = effectiveModelInfo(resolved, opts.preferences!);
			const field = await selectOne(ctx, summary ? `${modelLabel(id, opts)} — ${summary}` : modelLabel(id, opts), [
				{ value: "name", label: "Display name", suffix: ` • ${modelDisplayName(id, opts)}`, description: "Edit the display name; keep the exact API model id" },
				{ value: "thinking-levels", label: "Supported thinking levels", suffix: ` • ${supportedThinkingLevels(effective)?.join(" / ") ?? "unknown"}`, description: `${effective.sources?.thinkingLevelMap ?? effective.sources?.reasoning ?? "unknown"} • Auto or manual checkboxes` },
				{ value: "image", label: "Image input", suffix: ` • ${resolved.image === undefined && opts.preferences!.image === undefined ? "unknown" : opts.image ? "on" : "off"}`, description: `Capability source: ${resolved.sources?.image ?? "unknown"} • manual changes are kept on refresh` },
				{ value: "context", label: "Context window", suffix: ` • ${opts.contextWindow ?? "unset"}`, description: "Max context tokens for this model" },
				{ value: "maxtokens", label: "Max output tokens", suffix: ` • ${opts.maxTokens ?? "unset"}`, description: "Max tokens this model may generate" },
				{ value: "done", label: "Done", description: "Confirm this model and continue" },
			]);
			if (field === null || field === "done") break;
			if (field === "thinking-levels") {
				const choice = await promptSupportedThinkingLevels(ctx, resolved, opts.preferences);
				if (!choice) continue;
				const preferences = { ...opts.preferences };
				if (choice.mode === "auto") delete preferences.thinkingLevelMap;
				else preferences.thinkingLevelMap = choice.map;
				const info = effectiveModelInfo(resolved, preferences);
				const entry: any = { id, reasoning: info.reasoning ?? false };
				applyModelCapabilities(entry, info, preferences);
				opts.preferences = preferences;
				opts.reasoning = supportedThinkingLevels(info)?.at(-1) ?? (info.reasoning ? "high" : "off");
				opts.thinkingLevelMap = entry.thinkingLevelMap;
			} else if (field === "name") {
				const choice = await promptModelName(ctx, id, modelDisplayName(id, opts), resolved);
				if (!choice) continue;
				if (choice.mode === "auto") { delete opts.preferences!.name; opts.name = resolved.name; }
				else { opts.preferences!.name = choice.value; opts.name = choice.value ?? undefined; }
			} else if (field === "image") {
				const v = await promptImage(ctx, opts.image);
				if (v !== null) { opts.image = v; opts.preferences!.image = v; }
			} else if (field === "context") {
				const choice = await promptContextChoice(ctx, opts.contextWindow, resolved);
				if (choice?.mode === "auto") { delete opts.preferences!.contextWindow; opts.contextWindow = resolved.contextWindow; }
				else if (choice) { opts.contextWindow = choice.value ?? undefined; opts.preferences!.contextWindow = choice.value; }
			} else if (field === "maxtokens") {
				const v = await promptMaxTokens(ctx, opts.maxTokens);
				if (v !== null) { opts.maxTokens = v > 0 ? v : undefined; opts.preferences!.maxTokens = v > 0 ? v : null; }
			}
		}

		ids.push(id);
		options.set(id, opts);
	}
	return ids.length > 0 ? { ids, options } : null;
}

export async function promptProviderStyle(
	ctx: CommandContext,
): Promise<{ style: ProviderStyle; api: ProviderApi } | null> {
	const choice = await selectOne(ctx, "Provider style", [
		{ value: "openai", label: "OpenAI-compatible (Chat Completions)", description: 'api: "openai-completions" — most OpenAI-compatible servers' },
		{ value: "openai-responses", label: "OpenAI Responses API", description: 'api: "openai-responses" — the newer /responses endpoint' },
		{ value: "anthropic", label: "Anthropic-compatible", description: 'api: "anthropic-messages"' },
		{ value: "gemini", label: "Gemini (Google generative AI)", description: 'api: "google-generative-ai" — native Gemini format, baseUrl includes /v1beta' },
		{ value: "ollama", label: "Ollama-compatible", description: 'api: "openai-completions" with Ollama-specific compat defaults' },
	]);
	if (!choice) return null;

	const style = choice as ProviderStyle;
	const api: ProviderApi =
		style === "anthropic"
			? "anthropic-messages"
			: style === "openai-responses"
				? "openai-responses"
				: style === "gemini"
					? "google-generative-ai"
					: "openai-completions";
	return { style, api };
}

export async function promptEndpoint(
	ctx: CommandContext,
	style: ProviderStyle,
	api: ProviderApi,
): Promise<{ normalized: string; raw: string } | null> {
	const endpointInput = await ctx.ui.input(
		"Endpoint",
		style === "anthropic"
			? "e.g. https://api.anthropic-proxy.com/v1"
			: style === "ollama"
				? "e.g. http://localhost:11434/v1"
				: style === "gemini"
					? "e.g. https://generativelanguage.googleapis.com/v1beta"
					: style === "openai-responses"
						? "e.g. https://api.openai.com/v1"
						: "e.g. https://api.example.com/v1 or http://localhost:11434/v1",
	);
	if (endpointInput === undefined) return null;
	const raw = endpointInput.trim();
	if (!raw) {
		ctx.ui.notify("Endpoint is required.", "error");
		return null;
	}

	try {
		return { normalized: normalizeEndpoint(raw, api), raw };
	} catch (error) {
		ctx.ui.notify(`Invalid endpoint: ${error instanceof Error ? error.message : String(error)}`, "error");
		return null;
	}
}

export async function promptProviderIdentity(ctx: CommandContext, normalizedEndpoint: string, suggestion?: string): Promise<ProviderIdentity | null> {
	let existingIds = new Set<string>();
	try {
		existingIds = new Set(Object.keys(loadModelsConfig().providers ?? {}));
	} catch {
		// If config can't be read, persistProvider surfaces the error later.
	}

	const providerIdSuggestion = suggestion ?? suggestProviderId(normalizedEndpoint);
	const suggestionTaken = existingIds.has(providerIdSuggestion);

	while (true) {
		const providerNameInput = await ctx.ui.input(
			suggestionTaken ? "Provider name (must be unique)" : `Provider name (blank = ${providerIdSuggestion})`,
			"e.g. AxonHub — spelling is preserved; the id is lowercase",
		);
		if (providerNameInput === undefined) return null;
		const name = providerNameInput.trim() || providerIdSuggestion;
		const { id: providerId } = providerIdentity(name);
		if (!providerId) {
			ctx.ui.notify("Provider name is required.", "error");
			continue;
		}

		// Provider names must be unique — never silently overwrite an existing one.
		if (existingIds.has(providerId)) {
			ctx.ui.notify(`Provider "${providerId}" already exists. Choose a different name.`, "warning");
			continue;
		}

		if (BUILTIN_PROVIDER_IDS.has(providerId)) {
			const resolved = await resolveBuiltinCollision(ctx, providerId);
			if (resolved === null) continue;
			if (existingIds.has(resolved)) {
				ctx.ui.notify(`Provider "${resolved}" already exists. Choose a different name.`, "warning");
				continue;
			}
			return providerIdentity(name, resolved);
		}
		return providerIdentity(name, providerId);
	}
}

// One-click way out when an id collides with a built-in provider: rename to
// "<id>-custom", keep the collision (deliberate built-in extension), or go
// back and pick another name. Returns the id to use, or null to re-prompt.
export async function resolveBuiltinCollision(ctx: CommandContext, providerId: string): Promise<string | null> {
	const suggested = `${providerId}-custom`;
	const choice = await selectOne(ctx, `"${providerId}" collides with a built-in provider`, [
		{
			value: "rename",
			label: `Use "${suggested}" instead`,
			description: "Recommended — your models and key stay fully separate from the built-in provider",
		},
		{
			value: "keep",
			label: `Keep "${providerId}"`,
			description: `Extend the built-in on purpose. ${BUILTIN_COLLISION_WARNING}`,
		},
		{ value: "back", label: "Pick another name", description: "Go back and enter a different provider name" },
	]);
	if (choice === "rename") return suggested;
	if (choice === "keep") return providerId;
	return null;
}
