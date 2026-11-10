import type { DepartmentId, SharedAreaId } from "../departments";

/** Floor coordinates in metres on the x/z plane; the floor's top-left corner is (0, 0). */
export interface Vec2 {
  x: number;
  z: number;
}

export interface RoomRect {
  id: DepartmentId | SharedAreaId;
  x: number;
  z: number;
  w: number;
  d: number;
  /** Door on the corridor wall. */
  door: Vec2;
  /** Which side of the corridor the room sits on. */
  side: "north" | "south";
}

export const FLOOR = { w: 24, d: 17 } as const;
/** East-west corridor between the two rows of rooms. */
export const CORRIDOR = { x: 0, z: 7, w: 24, d: 2 } as const;
const CORRIDOR_MID = CORRIDOR.z + CORRIDOR.d / 2;

function north(id: RoomRect["id"], x: number, w: number): RoomRect {
  return { id, x, z: 0, w, d: CORRIDOR.z, door: { x: x + w / 2, z: CORRIDOR.z }, side: "north" };
}
function south(id: RoomRect["id"], x: number, w: number): RoomRect {
  const z = CORRIDOR.z + CORRIDOR.d;
  return { id, x, z, w, d: FLOOR.d - z, door: { x: x + w / 2, z }, side: "south" };
}

export const ROOMS: readonly RoomRect[] = [
  north("executive", 0, 8),
  north("analysis", 8, 8),
  north("meeting", 16, 8),
  south("engineering", 0, 8),
  south("quality", 8, 6),
  south("server", 14, 4),
  south("pantry", 18, 6),
];

export const DESKS_PER_DEPARTMENT = 6;
const GRID_COLS = 3;
const GRID_ROWS = 2;

function roomById(id: RoomRect["id"]): RoomRect {
  const room = ROOMS.find((candidate) => candidate.id === id);
  if (!room) throw new Error(`Unknown room ${id}`);
  return room;
}

/** Grid cell inside a room, kept away from the corridor wall so the doorway stays clear. */
function gridPoint(room: RoomRect, index: number): Vec2 {
  const col = index % GRID_COLS;
  const row = Math.floor(index / GRID_COLS) % GRID_ROWS;
  const x = room.x + (room.w * (col + 1)) / (GRID_COLS + 1);
  // Rows sit in the half of the room farthest from the door.
  const fractions = room.side === "north" ? [0.3, 0.62] : [0.42, 0.75];
  return { x, z: room.z + room.d * fractions[row] };
}

/** Where an agent sits, and the yaw (radians) it faces while working at the desk. */
export function deskSlot(department: DepartmentId, index: number): { seat: Vec2; facing: number } {
  const room = roomById(department);
  const seat = gridPoint(room, index % DESKS_PER_DEPARTMENT);
  // North rooms face their desks toward the back wall (-z); south rooms toward +z.
  return { seat, facing: room.side === "north" ? Math.PI : 0 };
}

const AREA_COLS = 3;
const AREA_ROWS = 3;
const AREA_SPOTS = AREA_COLS * AREA_ROWS;

/**
 * Distinct standing spots inside a shared area on a 3×3 grid; alternate columns are staggered so the
 * floating labels of a crowd sit at different heights on screen. Agents beyond nine get nudged apart.
 */
export function areaSpot(area: SharedAreaId, index: number): Vec2 {
  const room = roomById(area);
  const slot = index % AREA_SPOTS;
  const col = slot % AREA_COLS;
  const row = Math.floor(slot / AREA_COLS);
  const stagger = col % 2 === 1 ? 0.45 : 0;
  const x = room.x + (room.w * (col + 1)) / (AREA_COLS + 1);
  const z = room.z + room.d * (0.2 + row * 0.27) + stagger;
  const lap = Math.floor(index / AREA_SPOTS);
  return lap === 0 ? { x, z } : { x: x + 0.35 * lap, z: z + 0.35 * lap };
}

export function roomAt(point: Vec2): RoomRect | null {
  return ROOMS.find((room) => point.x > room.x && point.x < room.x + room.w && point.z > room.z && point.z < room.z + room.d) ?? null;
}

/** Waypoints from `from` to `to` (excluding `from`), through doors and the corridor only. */
export function findPath(from: Vec2, to: Vec2): Vec2[] {
  const fromRoom = roomAt(from);
  const toRoom = roomAt(to);
  if (fromRoom && fromRoom === toRoom) return [to];

  const points: Vec2[] = [];
  if (fromRoom) {
    points.push({ ...fromRoom.door }, { x: fromRoom.door.x, z: CORRIDOR_MID });
  } else {
    points.push({ x: from.x, z: CORRIDOR_MID });
  }
  if (toRoom) {
    points.push({ x: toRoom.door.x, z: CORRIDOR_MID }, { ...toRoom.door });
  } else {
    points.push({ x: to.x, z: CORRIDOR_MID });
  }
  points.push(to);

  return points.filter((point, index) => index === 0 || point.x !== points[index - 1].x || point.z !== points[index - 1].z);
}
