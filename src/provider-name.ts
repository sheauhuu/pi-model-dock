import type { ProviderIdentity } from "./types.ts";
import { slugify } from "./url.ts";

// Keep the original spelling separately from the config/auth lookup id.
export function providerIdentity(input: string, id = slugify(input)): ProviderIdentity {
	const name = input.trim();
	return { id, ...(name && name !== id ? { name } : {}) };
}

export function providerDisplayName(id: string, provider: { name?: unknown } | undefined): string {
	const name = typeof provider?.name === "string" ? provider.name.trim() : "";
	return name || id;
}

export function providerLabel(id: string, provider: { name?: unknown } | undefined): string {
	const name = providerDisplayName(id, provider);
	return name === id ? id : `${name} (${id})`;
}
