/** Reorder live entries without erasing archived/hidden slots in the saved sequence. */
export function mergeVisibleOrder(previous: string[], visible: string[]): string[] {
	const next = [...new Set(visible)];
	const live = new Set(next);
	const seen = new Set<string>();
	let at = 0;
	const result: string[] = [];
	for (const item of previous) {
		if (seen.has(item)) continue;
		seen.add(item);
		result.push(live.has(item) ? next[at++]! : item);
	}
	while (at < next.length) result.push(next[at++]!);
	return result;
}
