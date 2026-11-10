import { describe, expect, it } from "vitest";
import { DEPARTMENTS } from "../departments";
import { CORRIDOR, DESKS_PER_DEPARTMENT, ROOMS, areaSpot, deskSlot, findPath, roomAt, type RoomRect, type Vec2 } from "./layout";

const inside = (room: RoomRect, p: Vec2) => p.x > room.x && p.x < room.x + room.w && p.z > room.z && p.z < room.z + room.d;
const room = (id: RoomRect["id"]) => ROOMS.find((r) => r.id === id)!;
const inCorridor = (p: Vec2) => p.z >= CORRIDOR.z && p.z <= CORRIDOR.z + CORRIDOR.d;

describe("office layout", () => {
  it("has the 4 departments and 3 shared areas without overlap", () => {
    expect(ROOMS.map((r) => r.id).sort()).toEqual(["analysis", "engineering", "executive", "meeting", "pantry", "quality", "server"]);
    for (const a of ROOMS) {
      for (const b of ROOMS) {
        if (a === b) continue;
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.z < b.z + b.d && b.z < a.z + a.d;
        expect(overlap, `${a.id} overlaps ${b.id}`).toBe(false);
      }
    }
  });

  it("has at least 20 desks, each inside its department room", () => {
    expect(DESKS_PER_DEPARTMENT * DEPARTMENTS.length).toBeGreaterThanOrEqual(20);
    for (const department of DEPARTMENTS) {
      for (let i = 0; i < DESKS_PER_DEPARTMENT; i++) {
        expect(inside(room(department.id), deskSlot(department.id, i).seat)).toBe(true);
      }
    }
  });

  it("gives distinct desk seats within capacity and wraps beyond it", () => {
    const seats = Array.from({ length: DESKS_PER_DEPARTMENT }, (_, i) => deskSlot("engineering", i).seat);
    expect(new Set(seats.map((s) => `${s.x},${s.z}`)).size).toBe(DESKS_PER_DEPARTMENT);
    expect(deskSlot("engineering", DESKS_PER_DEPARTMENT)).toEqual(deskSlot("engineering", 0));
  });

  it("gives distinct spots in each shared area", () => {
    for (const area of ["meeting", "server", "pantry"] as const) {
      const spots = Array.from({ length: 6 }, (_, i) => areaSpot(area, i));
      expect(new Set(spots.map((s) => `${s.x},${s.z}`)).size).toBe(6);
      for (const spot of spots) expect(inside(room(area), spot)).toBe(true);
    }
  });

  it("finds the room containing a point", () => {
    expect(roomAt(deskSlot("quality", 0).seat)?.id).toBe("quality");
    expect(roomAt({ x: 5, z: CORRIDOR.z + CORRIDOR.d / 2 })).toBeNull();
  });

  it("routes between rooms through doors and the corridor only", () => {
    const from = deskSlot("executive", 0).seat;
    const to = areaSpot("pantry", 0);
    const path = findPath(from, to);
    expect(path[path.length - 1]).toEqual(to);
    for (const point of path) {
      const ok = inside(room("executive"), point) || inside(room("pantry"), point) || inCorridor(point)
        || ROOMS.some((r) => r.door.x === point.x && r.door.z === point.z);
      expect(ok, `waypoint ${point.x},${point.z} cuts through another room`).toBe(true);
    }
    expect(path.some((p) => p.x === room("executive").door.x && p.z === room("executive").door.z)).toBe(true);
    expect(path.some((p) => p.x === room("pantry").door.x && p.z === room("pantry").door.z)).toBe(true);
  });

  it("walks straight within the same room", () => {
    const from = deskSlot("engineering", 0).seat;
    const to = deskSlot("engineering", 3).seat;
    expect(findPath(from, to)).toEqual([to]);
  });
});
