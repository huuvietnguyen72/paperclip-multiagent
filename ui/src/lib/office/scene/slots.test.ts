import { describe, expect, it } from "vitest";
import { SlotBook } from "./slots";

const want = (entries: Array<[string, string]>) => new Map(entries);

describe("SlotBook", () => {
  it("gives newcomers the lowest free slot in their group", () => {
    const book = new SlotBook();
    const slots = book.sync(want([["a", "pantry"], ["b", "pantry"], ["c", "server"]]));
    expect(slots.get("a")).toBe(0);
    expect(slots.get("b")).toBe(1);
    expect(slots.get("c")).toBe(0);
  });

  it("keeps everyone else in place when one member leaves", () => {
    const book = new SlotBook();
    book.sync(want([["ceo", "pantry"], ["ba", "pantry"], ["tl", "pantry"]]));
    const after = book.sync(want([["ba", "pantry"], ["tl", "pantry"]]));
    expect(after.get("ba")).toBe(1);
    expect(after.get("tl")).toBe(2);
  });

  it("returns a member to a free slot without moving the others", () => {
    const book = new SlotBook();
    book.sync(want([["ceo", "pantry"], ["ba", "pantry"], ["tl", "pantry"]]));
    book.sync(want([["ba", "pantry"], ["tl", "pantry"]]));
    const back = book.sync(want([["ba", "pantry"], ["tl", "pantry"], ["ceo", "pantry"]]));
    expect(back.get("ceo")).toBe(0);
    expect(back.get("ba")).toBe(1);
    expect(back.get("tl")).toBe(2);
  });

  it("frees the old slot when a member changes group", () => {
    const book = new SlotBook();
    book.sync(want([["a", "pantry"], ["b", "pantry"]]));
    const moved = book.sync(want([["a", "server"], ["b", "pantry"], ["c", "pantry"]]));
    expect(moved.get("a")).toBe(0);
    expect(moved.get("b")).toBe(1);
    expect(moved.get("c")).toBe(0);
  });
});
