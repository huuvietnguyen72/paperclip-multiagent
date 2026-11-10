import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { OfficeAgentView } from "../agent-state";
import type { DepartmentId, SharedAreaId } from "../departments";
import { buildOffice } from "./build-office";
import { OfficeCharacter } from "./character";
import { FLOOR, ROOMS, areaSpot, deskSlot, findPath, type Vec2 } from "./layout";
import { BACKGROUND_COLOR, SELECTION_COLOR, characterColors } from "./palette";
import { SlotBook } from "./slots";

export type OfficeFocus = DepartmentId | SharedAreaId | "home";
export interface ScreenPoint {
  x: number;
  y: number;
  visible: boolean;
  /** Distance from the camera in metres (for label scale and stacking). */
  distance: number;
}

const LABEL_HEIGHT = 1.95;
const MIN_DISTANCE = 8;
const MAX_DISTANCE = 45;
const HOME_DISTANCE = 30;
const FOCUS_DISTANCE = 13;
const GLIDE_MS = 600;
const PICK_SLOP_PX = 5;
const CENTER = new THREE.Vector3(FLOOR.w / 2, 0, FLOOR.d / 2);
// Isometric-leaning default view from the south-east.
const HOME_DIRECTION = new THREE.Vector3(0.62, 0.78, 0.9).normalize();

interface Glide {
  start: number;
  fromTarget: THREE.Vector3;
  toTarget: THREE.Vector3;
  fromCamera: THREE.Vector3;
  toCamera: THREE.Vector3;
}

/** WebGL renderer for the office. Owns its RAF loop; call `dispose()` on unmount. */
export class OfficeScene {
  private readonly host: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly office: ReturnType<typeof buildOffice>;
  private readonly characters = new Map<string, OfficeCharacter>();
  private readonly paletteKeys = new Map<string, string>();
  private readonly deskBook = new SlotBook();
  private readonly areaBook = new SlotBook();
  private readonly selectionRing: THREE.Mesh;
  private readonly raycaster = new THREE.Raycaster();
  private readonly resizeObserver: ResizeObserver;
  private readonly frameListeners = new Set<() => void>();
  private pickListener: ((agentId: string | null) => void) | null = null;
  private selectedId: string | null = null;
  private followId: string | null = null;
  private glide: Glide | null = null;
  private rafId: number | null = null;
  private lastTime = 0;
  private pointerDown: { x: number; y: number } | null = null;
  private width = 1;
  private height = 1;
  private disposed = false;
  private homeDistance = HOME_DISTANCE;
  private framedHome = false;

  constructor(host: HTMLElement) {
    this.host = host;
    // Throws when WebGL is unavailable; the caller shows the fallback.
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.style.display = "block";
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
    this.renderer.domElement.style.touchAction = "none";
    host.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(BACKGROUND_COLOR);
    this.scene.fog = new THREE.Fog(BACKGROUND_COLOR, 55, 95);

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);
    this.camera.position.copy(CENTER).addScaledVector(HOME_DIRECTION, HOME_DISTANCE);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.copy(CENTER);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minPolarAngle = 0.3;
    this.controls.maxPolarAngle = 1.25;
    this.controls.minDistance = MIN_DISTANCE;
    this.controls.maxDistance = MAX_DISTANCE;
    this.controls.screenSpacePanning = false;
    this.controls.addEventListener("start", this.cancelGlide);

    const hemi = new THREE.HemisphereLight("#ffffff", "#4a4f57", 1.6);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight("#fff4e0", 2.2);
    sun.position.set(FLOOR.w + 8, 22, FLOOR.d + 14);
    sun.target.position.copy(CENTER);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -20;
    sun.shadow.camera.right = 20;
    sun.shadow.camera.top = 20;
    sun.shadow.camera.bottom = -20;
    sun.shadow.camera.far = 80;
    sun.shadow.bias = -0.0005;
    this.scene.add(sun, sun.target);

    this.office = buildOffice();
    this.scene.add(this.office.group);

    const ringGeometry = new THREE.RingGeometry(0.42, 0.55, 32);
    ringGeometry.rotateX(-Math.PI / 2);
    this.selectionRing = new THREE.Mesh(ringGeometry, new THREE.MeshBasicMaterial({ color: SELECTION_COLOR, transparent: true, opacity: 0.9 }));
    this.selectionRing.position.y = 0.06;
    this.selectionRing.visible = false;
    this.scene.add(this.selectionRing);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();

    this.renderer.domElement.addEventListener("pointerdown", this.handlePointerDown);
    this.renderer.domElement.addEventListener("pointerup", this.handlePointerUp);
    document.addEventListener("visibilitychange", this.handleVisibility);
    this.start();
  }

  setAgents(views: OfficeAgentView[]): void {
    const seen = new Set<string>();
    // Slots persist: an agent keeps its desk and its spot in a shared area while others come and go.
    const deskOf = this.deskBook.sync(new Map(views.map((view) => [view.id, view.department])));
    const spotOf = this.areaBook.sync(new Map(views.filter((view) => view.spot !== "desk").map((view) => [view.id, view.spot])));

    for (const view of views) {
      seen.add(view.id);
      const desk = deskSlot(view.department, deskOf.get(view.id) ?? 0);

      let target: Vec2;
      let facing: number | null = null;
      if (view.spot === "desk") {
        target = desk.seat;
        facing = desk.facing;
      } else {
        target = areaSpot(view.spot, spotOf.get(view.id) ?? 0);
      }

      const colors = characterColors(view.paletteId, view.muted);
      const paletteKey = `${colors.a}/${colors.b}`;
      let character = this.characters.get(view.id);
      if (!character) {
        character = new OfficeCharacter(view.id, colors, target);
        this.characters.set(view.id, character);
        this.scene.add(character.object);
        if (facing != null) character.goTo([target], facing);
      } else {
        if (this.paletteKeys.get(view.id) !== paletteKey) character.setColors(colors);
        const end = character.destination();
        const pendingEnd = character.pendingPath?.[character.pendingPath.length - 1];
        const goal = pendingEnd ?? end;
        if (Math.hypot(goal.x - target.x, goal.z - target.z) > 0.01) {
          character.goTo(findPath(end, target), facing);
        }
      }
      this.paletteKeys.set(view.id, paletteKey);
      character.setPose(view.pose);
    }

    for (const [id, character] of this.characters) {
      if (seen.has(id)) continue;
      character.dispose();
      this.characters.delete(id);
      this.paletteKeys.delete(id);
      if (this.selectedId === id) this.setSelected(null);
      if (this.followId === id) this.followId = null;
    }
  }

  setSelected(id: string | null): void {
    this.selectedId = id && this.characters.has(id) ? id : null;
    this.selectionRing.visible = this.selectedId != null;
  }

  focusAgent(id: string): void {
    const character = this.characters.get(id);
    if (!character) return;
    const p = character.position();
    this.glideTo(new THREE.Vector3(p.x, 0.8, p.z), FOCUS_DISTANCE);
  }

  focusArea(id: OfficeFocus): void {
    if (id === "home") {
      this.glideTo(CENTER.clone(), this.homeDistance, HOME_DIRECTION);
      return;
    }
    const room = ROOMS.find((candidate) => candidate.id === id);
    if (!room) return;
    this.glideTo(new THREE.Vector3(room.x + room.w / 2, 0, room.z + room.d / 2), Math.max(room.w, room.d) * 1.7);
  }

  setFollow(id: string | null): void {
    this.followId = id && this.characters.has(id) ? id : null;
    if (this.followId) this.focusAgent(this.followId);
  }

  zoomBy(factor: number): void {
    this.cancelGlide();
    const offset = this.camera.position.clone().sub(this.controls.target);
    const distance = THREE.MathUtils.clamp(offset.length() / factor, MIN_DISTANCE, MAX_DISTANCE);
    this.camera.position.copy(this.controls.target).addScaledVector(offset.normalize(), distance);
  }

  zoomPercent(): number {
    return Math.round((this.homeDistance / this.camera.position.distanceTo(this.controls.target)) * 100);
  }

  onPick(listener: (agentId: string | null) => void): void {
    this.pickListener = listener;
  }

  /** Runs after every rendered frame (used to move DOM labels without React re-renders). */
  onFrame(listener: () => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  labelPositions(): Map<string, ScreenPoint> {
    const out = new Map<string, ScreenPoint>();
    const v = new THREE.Vector3();
    for (const [id, character] of this.characters) {
      const p = character.position();
      out.set(id, this.project(v.set(p.x, LABEL_HEIGHT, p.z)));
    }
    return out;
  }

  roomLabelPositions(): Map<RoomRectId, ScreenPoint> {
    const out = new Map<RoomRectId, ScreenPoint>();
    const v = new THREE.Vector3();
    for (const room of ROOMS) {
      const z = room.side === "north" ? room.z + 0.6 : room.z + room.d - 0.4;
      out.set(room.id, this.project(v.set(room.x + room.w / 2, 0.1, z)));
    }
    return out;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    this.resizeObserver.disconnect();
    document.removeEventListener("visibilitychange", this.handleVisibility);
    this.renderer.domElement.removeEventListener("pointerdown", this.handlePointerDown);
    this.renderer.domElement.removeEventListener("pointerup", this.handlePointerUp);
    this.controls.removeEventListener("start", this.cancelGlide);
    this.controls.dispose();
    for (const character of this.characters.values()) character.dispose();
    this.characters.clear();
    this.office.dispose();
    this.selectionRing.geometry.dispose();
    (this.selectionRing.material as THREE.Material).dispose();
    this.frameListeners.clear();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private project(point: THREE.Vector3): ScreenPoint {
    const distance = point.distanceTo(this.camera.position);
    point.project(this.camera);
    const visible = point.z < 1 && point.x >= -1.1 && point.x <= 1.1 && point.y >= -1.1 && point.y <= 1.1;
    return { x: ((point.x + 1) / 2) * this.width, y: ((1 - point.y) / 2) * this.height, visible, distance };
  }

  /** Camera distance that fits the whole floor in the current viewport. */
  private fitDistance(): number {
    const halfFov = THREE.MathUtils.degToRad(this.camera.fov / 2);
    const radius = Math.hypot(FLOOR.w, FLOOR.d) / 2;
    const vertical = radius / Math.tan(halfFov);
    const horizontal = radius / (Math.tan(halfFov) * (this.width / this.height));
    return THREE.MathUtils.clamp(Math.max(vertical, horizontal) * 0.95, MIN_DISTANCE, MAX_DISTANCE);
  }

  private glideTo(target: THREE.Vector3, distance: number, direction?: THREE.Vector3): void {
    const dir = direction ?? this.camera.position.clone().sub(this.controls.target).normalize();
    this.glide = {
      start: performance.now(),
      fromTarget: this.controls.target.clone(),
      toTarget: target,
      fromCamera: this.camera.position.clone(),
      toCamera: target.clone().addScaledVector(dir, THREE.MathUtils.clamp(distance, MIN_DISTANCE, MAX_DISTANCE)),
    };
  }

  private readonly cancelGlide = () => {
    this.glide = null;
  };

  private resize(): void {
    this.width = Math.max(1, this.host.clientWidth);
    this.height = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(this.width, this.height, false);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.homeDistance = this.fitDistance();
    // Frame the whole floor once the host has a real size; later resizes keep the user's view.
    if (!this.framedHome && this.host.clientWidth > 1 && this.host.clientHeight > 1) {
      this.framedHome = true;
      this.camera.position.copy(this.controls.target).addScaledVector(HOME_DIRECTION, this.homeDistance);
    }
  }

  private start(): void {
    if (this.rafId != null || this.disposed) return;
    this.lastTime = performance.now();
    this.rafId = requestAnimationFrame(this.tick);
  }

  private stop(): void {
    if (this.rafId != null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  private readonly handleVisibility = () => {
    if (document.hidden) this.stop();
    else this.start();
  };

  private readonly tick = (time: number) => {
    this.rafId = requestAnimationFrame(this.tick);
    const dt = Math.min(0.05, Math.max(0, (time - this.lastTime) / 1000));
    this.lastTime = time;

    for (const character of this.characters.values()) character.update(dt);

    if (this.glide) {
      const t = Math.min(1, (time - this.glide.start) / GLIDE_MS);
      const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      this.controls.target.lerpVectors(this.glide.fromTarget, this.glide.toTarget, eased);
      this.camera.position.lerpVectors(this.glide.fromCamera, this.glide.toCamera, eased);
      if (t >= 1) this.glide = null;
    } else if (this.followId) {
      const followed = this.characters.get(this.followId);
      if (followed) {
        const p = followed.position();
        const delta = new THREE.Vector3(p.x, 0.8, p.z).sub(this.controls.target);
        this.controls.target.add(delta);
        this.camera.position.add(delta);
      }
    }

    if (this.selectedId) {
      const selected = this.characters.get(this.selectedId);
      if (selected) {
        const p = selected.position();
        this.selectionRing.position.set(p.x, 0.06, p.z);
      }
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    for (const listener of this.frameListeners) listener();
  };

  private readonly handlePointerDown = (event: PointerEvent) => {
    this.pointerDown = { x: event.clientX, y: event.clientY };
  };

  private readonly handlePointerUp = (event: PointerEvent) => {
    const down = this.pointerDown;
    this.pointerDown = null;
    if (!down || Math.hypot(event.clientX - down.x, event.clientY - down.y) > PICK_SLOP_PX) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(Array.from(this.characters.values(), (character) => character.object), true);
    const agentId = hits.find((hit) => typeof hit.object.userData.agentId === "string")?.object.userData.agentId as string | undefined;
    this.pickListener?.(agentId ?? null);
  };
}

type RoomRectId = (typeof ROOMS)[number]["id"];
