export function modelDisplayName(id: string, model: { name?: unknown } | undefined): string {
	const name = typeof model?.name === "string" ? model.name.trim() : "";
	return name || id;
}

export function modelLabel(id: string, model: { name?: unknown } | undefined): string {
	const name = modelDisplayName(id, model);
	return name === id ? id : `${name} (${id})`;
}
