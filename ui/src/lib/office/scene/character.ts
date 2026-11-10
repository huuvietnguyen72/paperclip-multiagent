import * as THREE from "three";
import type { OfficePose } from "../agent-state";
import type { Vec2 } from "./layout";
import { SKIN_COLOR, TROUSER_COLOR } from "./palette";

export const WALK_SPEED = 3.2; // metres per second; brisk so a cross-floor walk takes a few seconds
const STRIDE_RATE = 15; // leg swing frequency, matched to the walk speed
const TURN_SPEED = 10; // radians per second
const ARRIVE_EPSILON = 1e-6;

/** A low-poly office worker built from primitives. Pure motion state lives here so it can be unit-tested. */
export class OfficeCharacter {
  readonly id: string;
  readonly object = new THREE.Group();

  private readonly shirt: THREE.MeshStandardMaterial;
  private readonly hair: THREE.MeshStandardMaterial;
  private readonly owned: Array<THREE.BufferGeometry | THREE.Material> = [];
  private readonly leftArm: THREE.Mesh;
  private readonly rightArm: THREE.Mesh;
  private readonly leftLeg: THREE.Mesh;
  private readonly rightLeg: THREE.Mesh;
  private readonly body = new THREE.Group();

  private pos: Vec2;
  private path: Vec2[] = [];
  private pending: Vec2[] | null = null;
  private pendingFacing: number | null = null;
  private finalFacing: number | null = null;
  private yaw = 0;
  private pose: OfficePose = "idle";
  private clock = Math.random() * 10;

  constructor(id: string, colors: { a: string; b: string }, start: Vec2) {
    this.id = id;
    this.pos = { ...start };
    this.object.name = `agent:${id}`;
    this.object.userData.agentId = id;

    const skin = this.own(new THREE.MeshStandardMaterial({ color: SKIN_COLOR, roughness: 0.8 }));
    const trousers = this.own(new THREE.MeshStandardMaterial({ color: TROUSER_COLOR, roughness: 0.9 }));
    this.shirt = this.own(new THREE.MeshStandardMaterial({ color: colors.a, roughness: 0.7 }));
    this.hair = this.own(new THREE.MeshStandardMaterial({ color: colors.b, roughness: 0.6 }));

    const torso = new THREE.Mesh(this.own(new THREE.CapsuleGeometry(0.2, 0.36, 4, 12)), this.shirt);
    torso.position.y = 0.95;
    const head = new THREE.Mesh(this.own(new THREE.SphereGeometry(0.19, 20, 16)), skin);
    head.position.y = 1.45;
    const hairCap = new THREE.Mesh(this.own(new THREE.SphereGeometry(0.205, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2)), this.hair);
    hairCap.position.y = 1.48;

    const armGeometry = this.own(new THREE.BoxGeometry(0.1, 0.42, 0.1));
    armGeometry.translate(0, -0.21, 0); // pivot at the shoulder
    this.leftArm = new THREE.Mesh(armGeometry, this.shirt);
    this.rightArm = new THREE.Mesh(armGeometry, this.shirt);
    this.leftArm.position.set(-0.27, 1.18, 0);
    this.rightArm.position.set(0.27, 1.18, 0);

    const legGeometry = this.own(new THREE.BoxGeometry(0.13, 0.55, 0.13));
    legGeometry.translate(0, -0.275, 0); // pivot at the hip
    this.leftLeg = new THREE.Mesh(legGeometry, trousers);
    this.rightLeg = new THREE.Mesh(legGeometry, trousers);
    this.leftLeg.position.set(-0.1, 0.62, 0);
    this.rightLeg.position.set(0.1, 0.62, 0);

    for (const mesh of [torso, head, hairCap, this.leftArm, this.rightArm, this.leftLeg, this.rightLeg]) {
      mesh.castShadow = true;
      mesh.userData.agentId = id;
      this.body.add(mesh);
    }
    this.object.add(this.body);
    this.syncTransform();
  }

  private own<T extends THREE.BufferGeometry | THREE.Material>(resource: T): T {
    this.owned.push(resource);
    return resource;
  }

  get isWalking(): boolean {
    return this.path.length > 0;
  }

  get pendingPath(): Vec2[] | null {
    return this.pending;
  }

  position(): Vec2 {
    return { ...this.pos };
  }

  /** Where the character will end up once its current walk finishes. */
  destination(): Vec2 {
    return this.path.length > 0 ? { ...this.path[this.path.length - 1] } : this.position();
  }

  /** Walk a path; while already walking the path waits (latest wins) so the character never teleports. */
  goTo(path: Vec2[], facing: number | null = null): void {
    if (path.length === 0) return;
    if (this.isWalking) {
      this.pending = path.map((point) => ({ ...point }));
      this.pendingFacing = facing;
      return;
    }
    this.path = path.map((point) => ({ ...point }));
    this.finalFacing = facing;
  }

  setPose(pose: OfficePose): void {
    this.pose = pose;
  }

  setColors(colors: { a: string; b: string }): void {
    this.shirt.color.set(colors.a);
    this.hair.color.set(colors.b);
  }

  update(dtSec: number): void {
    this.clock += dtSec;
    let remaining = WALK_SPEED * dtSec;
    let targetYaw: number | null = null;

    while (remaining > 0 && this.path.length > 0) {
      const target = this.path[0];
      const dx = target.x - this.pos.x;
      const dz = target.z - this.pos.z;
      const distance = Math.hypot(dx, dz);
      if (distance > ARRIVE_EPSILON) targetYaw = Math.atan2(dx, dz);
      if (distance <= remaining) {
        this.pos = { ...target };
        this.path.shift();
        remaining -= distance;
      } else {
        this.pos = { x: this.pos.x + (dx / distance) * remaining, z: this.pos.z + (dz / distance) * remaining };
        remaining = 0;
      }
    }

    if (this.path.length === 0) {
      if (this.pending) {
        this.path = this.pending;
        this.finalFacing = this.pendingFacing;
        this.pending = null;
        this.pendingFacing = null;
      } else if (this.finalFacing != null) {
        targetYaw = this.finalFacing;
      }
    }

    if (targetYaw != null) this.turnToward(targetYaw, dtSec);
    this.animate();
    this.syncTransform();
  }

  private turnToward(targetYaw: number, dtSec: number): void {
    let delta = targetYaw - this.yaw;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    const step = TURN_SPEED * dtSec;
    this.yaw += Math.abs(delta) <= step ? delta : Math.sign(delta) * step;
  }

  private animate(): void {
    const t = this.clock;
    let leg = 0;
    let leftArm = 0;
    let rightArm = 0;
    let bob = 0;
    if (this.isWalking) {
      leg = Math.sin(t * STRIDE_RATE) * 0.6;
      leftArm = -leg * 0.7;
      rightArm = leg * 0.7;
      bob = Math.abs(Math.sin(t * STRIDE_RATE)) * 0.03;
    } else if (this.pose === "typing") {
      leftArm = -1.1 + Math.sin(t * 14) * 0.12;
      rightArm = -1.1 + Math.sin(t * 14 + 1.7) * 0.12;
    } else if (this.pose === "idle") {
      bob = Math.sin(t * 1.6) * 0.015;
    }
    this.leftLeg.rotation.x = leg;
    this.rightLeg.rotation.x = -leg;
    this.leftArm.rotation.x = leftArm;
    this.rightArm.rotation.x = rightArm;
    this.body.position.y = bob;
  }

  private syncTransform(): void {
    this.object.position.set(this.pos.x, 0, this.pos.z);
    this.object.rotation.y = this.yaw;
  }

  dispose(): void {
    for (const resource of this.owned) resource.dispose();
    this.object.removeFromParent();
  }
}
