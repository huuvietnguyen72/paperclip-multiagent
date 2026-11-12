export interface Point {
  x: number;
  y: number;
}

/** Cubic bezier from the agent card edge to a connection card edge, with horizontal tangents at both ends. */
export function curvePath(from: Point, to: Point): string {
  const midX = (from.x + to.x) / 2;
  return `M${from.x} ${from.y} C${midX} ${from.y} ${midX} ${to.y} ${to.x} ${to.y}`;
}

/**
 * Vertical middle of each card, relative to the top of `container`. Uses bounding rects so the result does not
 * depend on which ancestor is the offsetParent.
 */
export function cardAnchors(container: { top: number }, cards: Array<{ top: number; height: number }>): number[] {
  return cards.map((card) => card.top - container.top + card.height / 2);
}
