import { describe, expect, it } from "vitest";
import { cardAnchors, curvePath } from "./hub-geometry";

describe("hub geometry", () => {
  it("draws a cubic curve from the start point to the end point", () => {
    expect(curvePath({ x: 0, y: 50 }, { x: 80, y: 200 })).toBe("M0 50 C40 50 40 200 80 200");
  });

  it("measures card middles relative to the container top", () => {
    expect(cardAnchors({ top: 100 }, [{ top: 100, height: 60 }, { top: 172, height: 60 }])).toEqual([30, 102]);
  });
});
