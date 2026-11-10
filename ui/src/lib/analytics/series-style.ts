/** Eight validated categorical hues (see --series-* in index.css); a ninth series reuses a hue with a dashed line. */
export const SERIES_HUES = 8;

export function seriesStyle(index: number): { color: string; dashed: boolean } {
  return { color: `var(--series-${(index % SERIES_HUES) + 1})`, dashed: index >= SERIES_HUES };
}

/** Colour follows the entity: indexes come from a stable agent order, never from rank or visibility. */
export function assignSeriesIndex(agentIdsInStableOrder: readonly string[]): Map<string, number> {
  return new Map(agentIdsInStableOrder.map((id, index) => [id, index]));
}
