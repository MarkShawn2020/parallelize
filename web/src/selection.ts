/** Judges pick up to three cells on stage for the echo demo. */
export const MAX_SELECTED = 3;

/** Toggles a cell; picking a fourth drops the oldest pick so a click always does something visible. */
export function toggleSelected(selected: readonly string[], id: string, max = MAX_SELECTED): string[] {
  if (selected.includes(id)) return selected.filter((x) => x !== id);
  const next = [...selected, id];
  return next.length > max ? next.slice(next.length - max) : next;
}

/** The most recent pick, used as the target of single-cell actions (kill, compromise). */
export function primaryTarget(selected: readonly string[]): string | undefined {
  return selected.at(-1);
}
