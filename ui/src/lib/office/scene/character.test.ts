import { describe, expect, it } from "vitest";
import { OfficeCharacter, WALK_SPEED } from "./character";

const colors = { a: "#beffe8", b: "#ff797b" };

describe("OfficeCharacter", () => {
  it("walks along a path at the walking speed", () => {
    const character = new OfficeCharacter("a", colors, { x: 0, z: 0 });
    character.goTo([{ x: 10, z: 0 }]);
    expect(character.isWalking).toBe(true);
    character.update(1);
    expect(character.position().x).toBeCloseTo(WALK_SPEED, 5);
    expect(WALK_SPEED).toBe(3.2);
  });

  it("arrives and stops", () => {
    const character = new OfficeCharacter("a", colors, { x: 0, z: 0 });
    character.goTo([{ x: 1, z: 0 }, { x: 1, z: 1 }]);
    for (let i = 0; i < 20; i++) character.update(0.1);
    expect(character.position()).toEqual({ x: 1, z: 1 });
    expect(character.isWalking).toBe(false);
  });

  it("queues a new destination instead of teleporting while walking", () => {
    const character = new OfficeCharacter("a", colors, { x: 0, z: 0 });
    character.goTo([{ x: 2, z: 0 }]);
    character.update(0.5);
    const before = character.position();
    character.goTo([{ x: 0, z: 3 }]);
    expect(character.position()).toEqual(before);
    expect(character.pendingPath).toEqual([{ x: 0, z: 3 }]);
  });

  it("keeps only the latest pending path during a burst", () => {
    const character = new OfficeCharacter("a", colors, { x: 0, z: 0 });
    character.goTo([{ x: 2, z: 0 }]);
    character.goTo([{ x: 5, z: 5 }]);
    character.goTo([{ x: 6, z: 6 }]);
    character.goTo([{ x: 7, z: 7 }]);
    expect(character.pendingPath).toEqual([{ x: 7, z: 7 }]);
  });

  it("takes the pending path after arriving", () => {
    const character = new OfficeCharacter("a", colors, { x: 0, z: 0 });
    character.goTo([{ x: 1, z: 0 }]);
    character.goTo([{ x: 1, z: 1 }]);
    for (let i = 0; i < 30; i++) character.update(0.1);
    expect(character.position()).toEqual({ x: 1, z: 1 });
    expect(character.pendingPath).toBeNull();
  });

  it("disposes its geometry and materials", () => {
    const character = new OfficeCharacter("a", colors, { x: 0, z: 0 });
    expect(() => character.dispose()).not.toThrow();
  });
});
