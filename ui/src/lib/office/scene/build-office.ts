import * as THREE from "three";
import { DEPARTMENTS } from "../departments";
import { CORRIDOR, DESKS_PER_DEPARTMENT, FLOOR, ROOMS, deskSlot, type RoomRect } from "./layout";
import * as C from "./palette";

const WALL_HEIGHT = 2.6;
const PARTITION_HEIGHT = 1.7;
const WALL_THICKNESS = 0.12;
const DOOR_WIDTH = 1.4;

/**
 * Builds the static office floor: floors, walls, glass partitions and furniture. Everything is made from
 * primitives with shared geometries/materials, all disposed by the returned `dispose`.
 */
export function buildOffice(): { group: THREE.Group; dispose(): void } {
  const group = new THREE.Group();
  group.name = "office";
  const resources: Array<THREE.BufferGeometry | THREE.Material> = [];
  const material = (color: string, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) => {
    const m = new THREE.MeshStandardMaterial({ color, roughness: 0.85, ...extra });
    resources.push(m);
    return m;
  };
  const box = (w: number, h: number, d: number) => {
    const g = new THREE.BoxGeometry(w, h, d);
    resources.push(g);
    return g;
  };
  const add = (geometry: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, opts: { cast?: boolean; receive?: boolean; rotY?: number } = {}) => {
    const mesh = new THREE.Mesh(geometry, mat);
    mesh.position.set(x, y, z);
    if (opts.rotY) mesh.rotation.y = opts.rotY;
    mesh.castShadow = opts.cast ?? true;
    mesh.receiveShadow = opts.receive ?? true;
    group.add(mesh);
    return mesh;
  };

  // Ground around the building and the corridor.
  const groundGeo = new THREE.PlaneGeometry(FLOOR.w + 40, FLOOR.d + 40);
  resources.push(groundGeo);
  const ground = new THREE.Mesh(groundGeo, material(C.GROUND_COLOR, { roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(FLOOR.w / 2, -0.02, FLOOR.d / 2);
  ground.receiveShadow = true;
  ground.userData.floor = true;
  group.add(ground);

  add(box(CORRIDOR.w, 0.04, CORRIDOR.d), material(C.CORRIDOR_COLOR), CORRIDOR.x + CORRIDOR.w / 2, 0, CORRIDOR.z + CORRIDOR.d / 2, { cast: false }).userData.floor = true;

  for (const room of ROOMS) {
    add(box(room.w, 0.05, room.d), material(C.FLOOR_COLORS[room.id]), room.x + room.w / 2, 0, room.z + room.d / 2, { cast: false }).userData.floor = true;
  }

  // Walls: solid outer walls on the far (north/west) sides, low glass everywhere else so the camera sees in.
  const solid = material(C.WALL_COLOR);
  const glass = new THREE.MeshPhysicalMaterial({ color: C.GLASS_COLOR, transparent: true, opacity: 0.28, roughness: 0.05, metalness: 0, depthWrite: false });
  resources.push(glass);
  const wallX = (x1: number, x2: number, z: number, height: number, mat: THREE.Material) => {
    if (x2 - x1 <= 0.01) return;
    add(box(x2 - x1, height, WALL_THICKNESS), mat, (x1 + x2) / 2, height / 2, z, { cast: mat === solid });
  };
  const wallZ = (z1: number, z2: number, x: number, height: number, mat: THREE.Material) => {
    if (z2 - z1 <= 0.01) return;
    add(box(WALL_THICKNESS, height, z2 - z1), mat, x, height / 2, (z1 + z2) / 2, { cast: mat === solid });
  };

  wallX(0, FLOOR.w, 0, WALL_HEIGHT, solid); // north outer wall
  wallZ(0, FLOOR.d, 0, WALL_HEIGHT, solid); // west outer wall
  wallX(0, FLOOR.w, FLOOR.d, 0.5, solid); // low south outer wall (cutaway)
  wallZ(0, FLOOR.d, FLOOR.w, 0.5, solid); // low east outer wall (cutaway)

  const corridorWall = (room: RoomRect) => {
    const z = room.side === "north" ? CORRIDOR.z : CORRIDOR.z + CORRIDOR.d;
    wallX(room.x, room.door.x - DOOR_WIDTH / 2, z, PARTITION_HEIGHT, glass);
    wallX(room.door.x + DOOR_WIDTH / 2, room.x + room.w, z, PARTITION_HEIGHT, glass);
  };
  for (const room of ROOMS) {
    corridorWall(room);
    if (room.x > 0) wallZ(room.z, room.z + room.d, room.x, PARTITION_HEIGHT, glass);
  }

  // Desks with monitors and chairs in every department.
  const deskTop = box(1.3, 0.06, 0.65);
  const deskLeg = box(0.05, 0.72, 0.05);
  const monitor = box(0.55, 0.34, 0.04);
  const screen = box(0.5, 0.29, 0.01);
  const chairSeat = box(0.46, 0.08, 0.46);
  const chairBack = box(0.46, 0.5, 0.06);
  const deskMat = material(C.DESK_COLOR);
  const legMat = material(C.DESK_LEG_COLOR);
  const monitorMat = material(C.MONITOR_COLOR);
  const screenMat = material(C.SCREEN_COLOR, { emissive: C.SCREEN_COLOR, emissiveIntensity: 0.6 });
  const chairMat = material(C.CHAIR_COLOR);

  for (const department of DEPARTMENTS) {
    for (let i = 0; i < DESKS_PER_DEPARTMENT; i++) {
      const { seat, facing } = deskSlot(department.id, i);
      const dir = Math.cos(facing); // +1 faces +z, -1 faces -z
      const deskZ = seat.z + dir * 0.7;
      add(deskTop, deskMat, seat.x, 0.75, deskZ);
      for (const [dx, dz] of [[-0.6, -0.28], [0.6, -0.28], [-0.6, 0.28], [0.6, 0.28]]) {
        add(deskLeg, legMat, seat.x + dx, 0.36, deskZ + dz);
      }
      add(monitor, monitorMat, seat.x, 1.0, deskZ + dir * 0.18);
      add(screen, screenMat, seat.x, 1.0, deskZ + dir * 0.18 - dir * 0.025, { cast: false });
      add(chairSeat, chairMat, seat.x, 0.46, seat.z - dir * 0.15);
      add(chairBack, chairMat, seat.x, 0.75, seat.z - dir * 0.38);
    }
  }

  const roomOf = (id: RoomRect["id"]) => ROOMS.find((room) => room.id === id)!;

  // Meeting room: a long table with chairs.
  const meeting = roomOf("meeting");
  const tableMat = material(C.TABLE_COLOR);
  const mx = meeting.x + meeting.w / 2;
  const mz = meeting.z + meeting.d * 0.42;
  add(box(4.2, 0.08, 1.6), tableMat, mx, 0.76, mz);
  add(box(0.2, 0.72, 1.0), legMat, mx - 1.6, 0.36, mz);
  add(box(0.2, 0.72, 1.0), legMat, mx + 1.6, 0.36, mz);
  for (let i = -1.5; i <= 1.5; i += 1) {
    add(chairSeat, chairMat, mx + i, 0.46, mz - 1.15);
    add(chairSeat, chairMat, mx + i, 0.46, mz + 1.15);
  }
  add(box(2.4, 1.3, 0.06), monitorMat, mx, 1.5, meeting.z + 0.12); // wall screen
  add(box(2.2, 1.1, 0.02), screenMat, mx, 1.5, meeting.z + 0.16, { cast: false });

  // Server room: racks along the back wall with status lights.
  const server = roomOf("server");
  const rackMat = material(C.RACK_COLOR, { roughness: 0.5, metalness: 0.3 });
  const rackLightMat = material(C.RACK_LIGHT_COLOR, { emissive: C.RACK_LIGHT_COLOR, emissiveIntensity: 1.2 });
  const rackLight = box(0.5, 0.03, 0.02);
  for (let i = 0; i < 3; i++) {
    const rx = server.x + 0.7 + i * 1.3;
    const rz = server.z + server.d - 0.6;
    add(box(0.8, 2.0, 0.9), rackMat, rx, 1.0, rz);
    for (let level = 0; level < 5; level++) add(rackLight, rackLightMat, rx, 0.4 + level * 0.32, rz - 0.46, { cast: false });
  }

  // Pantry: counter, two small tables and a sofa.
  const pantry = roomOf("pantry");
  add(box(pantry.w - 0.6, 0.95, 0.7), material(C.COUNTER_COLOR), pantry.x + pantry.w / 2, 0.47, pantry.z + pantry.d - 0.5);
  for (const [tx, tz] of [[pantry.x + 1.4, pantry.z + 2.6], [pantry.x + pantry.w - 1.4, pantry.z + 2.6]]) {
    add(box(0.9, 0.05, 0.9), tableMat, tx, 0.74, tz);
    add(box(0.08, 0.72, 0.08), legMat, tx, 0.36, tz);
  }
  add(box(2.2, 0.45, 0.85), material(C.SOFA_COLOR), pantry.x + pantry.w / 2, 0.25, pantry.z + 4.6);
  add(box(2.2, 0.55, 0.2), material(C.SOFA_COLOR), pantry.x + pantry.w / 2, 0.55, pantry.z + 5.0);

  // Plants in room corners.
  const pot = box(0.4, 0.4, 0.4);
  const potMat = material(C.PLANT_POT_COLOR);
  const leafGeo = new THREE.SphereGeometry(0.42, 12, 10);
  resources.push(leafGeo);
  const leafMat = material(C.PLANT_COLOR);
  for (const room of ROOMS) {
    const px = room.x + 0.45;
    const pz = room.side === "north" ? room.z + 0.45 : room.z + room.d - 0.45;
    if (room.id === "server" || room.id === "pantry") continue;
    add(pot, potMat, px, 0.2, pz);
    add(leafGeo, leafMat, px, 0.75, pz);
  }

  return {
    group,
    dispose() {
      for (const resource of resources) resource.dispose();
      group.removeFromParent();
    },
  };
}
