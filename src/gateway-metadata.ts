import { PROBE_TIMEOUT_MS } from "model-probe";
import type { ModelProbeInfo } from "./types.ts";

function positive(...values: unknown[]): number | undefined {
	return values.find((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
}

function boolean(...values: unknown[]): boolean | undefined {
	return values.find((value): value is boolean => typeof value === "boolean");
}

// Normalize only fields actually supplied by the gateway. These forms occur
// in AxonHub, Magpie, OpenRouter, Gemini and standard /models detail responses.
export function parseGatewayModel(raw: any): ModelProbeInfo {
	if (!raw || typeof raw !== "object") return {};
	const item = raw.data && !Array.isArray(raw.data) && typeof raw.data === "object" ? raw.data : raw;
	const meta = item.meta ?? {};
	const caps = item.capabilities ?? {};
	const info: ModelProbeInfo = {};
	const name = [item.display_name, item.displayName, typeof item.id === "string" ? item.name : undefined]
		.find(value => typeof value === "string" && value.trim() && value.trim() !== item.id);
	if (name) info.name = name.trim();
	info.contextWindow = positive(item.context_window, item.context_length, item.max_input_tokens, item.inputTokenLimit, meta.context_window, meta.max_input_tokens);
	info.maxTokens = positive(item.max_output_tokens, item.max_completion_tokens, item.outputTokenLimit, item.top_provider?.max_completion_tokens, meta.max_output_tokens, meta.max_tokens);
	const modalities = item.modalities?.input ?? item.architecture?.input_modalities ?? (Array.isArray(item.modalities) ? item.modalities : undefined);
	info.image = boolean(caps.vision?.supported, caps.vision, item.supports_vision, meta.supports_vision, meta.capabilities?.vision);
	info.video = boolean(caps.video?.supported, caps.video, item.supports_video);
	if (Array.isArray(modalities)) {
		info.image ??= modalities.includes("image");
		info.video ??= modalities.includes("video");
	}
	info.reasoning = boolean(caps.reasoning?.supported, caps.reasoning, item.reasoning, item.supports_reasoning, meta.supports_reasoning, meta.capabilities?.reasoning, meta.capabilities?.thinking);
	if (Array.isArray(caps)) {
		// A list mentioning vision/thinking is evidence for support. Absence
		// from an unspecified capability list is not evidence for false.
		if (caps.includes("vision")) info.image ??= true;
		if (caps.includes("reasoning") || caps.includes("thinking")) info.reasoning ??= true;
	}
	const reasoning = caps.reasoning && typeof caps.reasoning === "object" ? caps.reasoning : {};
	if (reasoning.type === "none") info.reasoning = false;
	if (reasoning.type === "minimal") { info.reasoning = true; info.alwaysThinking = true; }
	if (reasoning.type === "effort") info.reasoning ??= true;
	const options = reasoning.effort_options ?? item.effort_options ?? item.reasoning_levels ?? item.supported_reasoning_levels ?? (Array.isArray(item.reasoning_options) ? item.reasoning_options.find((option: any) => option?.type === "effort")?.values : undefined);
	if (Array.isArray(options)) {
		const values = options.map(value => typeof value === "string" ? value : value?.effort).filter((value): value is string => typeof value === "string" && value.trim().length > 0);
		if (values.length) { info.effortOptions = [...new Set(values)]; info.reasoning ??= true; }
	}
	if (typeof item.alwaysThinking === "boolean") info.alwaysThinking = item.alwaysThinking;
	if (Array.isArray(item.supported_endpoint_types)) info.endpointTypes = item.supported_endpoint_types;
	const pricing = item.pricing;
	if (pricing && typeof pricing === "object") {
		const price = (value: unknown) => value !== undefined && value !== null && value !== "" && Number.isFinite(Number(value)) && Number(value) >= 0 ? Math.round(Number(value) * 1e12) / 1e6 : undefined;
		const input = price(pricing.prompt ?? pricing.input_cost_per_token);
		const output = price(pricing.completion ?? pricing.output_cost_per_token);
		if (input !== undefined || output !== undefined) info.cost = { input: input ?? 0, output: output ?? 0, cacheRead: price(pricing.input_cache_read) ?? 0, cacheWrite: price(pricing.input_cache_write) ?? 0 };
	}
	return Object.fromEntries(Object.entries(info).filter(([, value]) => value !== undefined));
}

async function getJson(url: string, key?: string): Promise<any> {
	const headers: Record<string, string> = { accept: "application/json", "accept-encoding": "identity" };
	if (key) { headers.authorization = `Bearer ${key}`; headers["x-goog-api-key"] = key; }
	const response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
	if (!response.ok) {
		const error = new Error(`Metadata request failed (${response.status})`);
		Object.assign(error, { status: response.status });
		throw error;
	}
	return response.json();
}

export async function probeModels(baseUrl: string, key?: string) {
	const base = new URL(baseUrl);
	const variants = [baseUrl.replace(/\/+$/, "")];
	if (base.pathname.replace(/\/+$/, "").endsWith("/v1")) variants.push(variants[0].slice(0, -3));
	else if (base.pathname === "/" || base.pathname === "") variants.push(`${variants[0]}/v1`);
	const local = /^(localhost|127\.|10\.|192\.168\.|0\.0\.0\.0|\[::1\])/.test(base.hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(base.hostname) || base.hostname.endsWith(".local");
	if (base.protocol === "http:" && !local) variants.push(...variants.map(value => value.replace(/^http:/, "https:")));
	let lastError: unknown;
	for (const variant of [...new Set(variants)]) {
		try {
			const json = await getJson(`${variant}/models`, key);
			const entries = Array.isArray(json) ? json : json?.data ?? json?.models;
			if (!Array.isArray(entries)) throw new Error("Metadata response did not contain a model list");
			const infoById = new Map<string, ModelProbeInfo>();
			for (const item of entries) {
				if (!item || typeof item !== "object") continue;
				const id = (typeof item.id === "string" ? item.id : typeof item.name === "string" ? item.name : "").trim().replace(/^models\//, "");
				if (id) infoById.set(id, parseGatewayModel(item));
			}
			return { ids: [...infoById.keys()].sort((a, b) => a.localeCompare(b)), infoById, baseUrl: variant };
		} catch (error) {
			if ([401, 403].includes((error as any)?.status)) throw error;
			lastError = error;
		}
	}
	throw lastError ?? new Error("Model list unavailable");
}

export async function fetchPerModelInfo(baseUrl: string, ids: string[], key?: string): Promise<Map<string, ModelProbeInfo>> {
	const result = new Map<string, ModelProbeInfo>();
	let cursor = 0;
	await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
		while (cursor < ids.length) {
			const id = ids[cursor++];
			try { result.set(id, parseGatewayModel(await getJson(`${baseUrl.replace(/\/+$/, "")}/models/${encodeURIComponent(id)}`, key))); }
			catch { /* Detail endpoints are optional; missing fields remain unknown. */ }
		}
	}));
	return result;
}
