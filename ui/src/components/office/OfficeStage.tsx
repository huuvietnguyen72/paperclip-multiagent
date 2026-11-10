import { useEffect, useRef, useState } from "react";
import type { OfficeAgentView } from "@/lib/office/agent-state";
import { OfficeScene, type ScreenPoint } from "@/lib/office/scene/office-scene";
import { ROOMS } from "@/lib/office/scene/layout";
import { strings } from "@/lib/office/strings";
import { OfficeAgentLabel } from "./OfficeAgentLabel";
import { OfficeStageFallback } from "./OfficeStageFallback";
import { OfficeToolbar } from "./OfficeToolbar";

export interface OfficeStageProps {
  agents: OfficeAgentView[];
  now: number;
  selectedId: string | null;
  onSelect(id: string | null): void;
  onAssign(id: string | null): void;
}

const roomName = (id: (typeof ROOMS)[number]["id"]) =>
  (strings.departments as Record<string, string>)[id] ?? (strings.areas as Record<string, string>)[id] ?? id;

/** Labels shrink when the camera is far away and nearer labels stack on top, so crowds stay readable. */
const LABEL_FULL_SIZE_DISTANCE = 16;

function place(element: HTMLElement | null | undefined, point: ScreenPoint | undefined, anchor: string, scaled: boolean) {
  if (!element) return;
  if (!point || !point.visible) {
    element.style.display = "none";
    return;
  }
  const scale = scaled ? Math.min(1, Math.max(0.6, LABEL_FULL_SIZE_DISTANCE / point.distance)) : 1;
  element.style.display = "flex";
  element.style.zIndex = String(10_000 - Math.round(point.distance * 100));
  element.style.transform = `translate(${Math.round(point.x)}px, ${Math.round(point.y)}px) ${anchor} scale(${scale.toFixed(3)})`;
}

export default function OfficeStage({ agents, now, selectedId, onSelect, onAssign }: OfficeStageProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const [zoomPercent, setZoomPercent] = useState(100);
  const [following, setFollowing] = useState(false);
  const sceneRef = useRef<OfficeScene | null>(null);
  const labelRefs = useRef(new Map<string, HTMLButtonElement>());
  const roomRefs = useRef(new Map<string, HTMLSpanElement>());
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let scene: OfficeScene;
    try {
      scene = new OfficeScene(host);
    } catch {
      setFailed(true);
      return;
    }
    sceneRef.current = scene;
    scene.onPick((id) => onSelectRef.current(id));
    const stopFrames = scene.onFrame(() => {
      for (const [id, point] of scene.labelPositions()) place(labelRefs.current.get(id), point, "translate(-50%, -100%)", true);
      for (const [id, point] of scene.roomLabelPositions()) place(roomRefs.current.get(id), point, "translate(-50%, -50%)", false);
      const zoom = scene.zoomPercent();
      setZoomPercent((current) => (current === zoom ? current : zoom));
    });
    return () => {
      stopFrames();
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    sceneRef.current?.setAgents(agents);
  }, [agents]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    scene.setSelected(selectedId);
    if (selectedId) scene.focusAgent(selectedId);
    // Following always applies to the selected agent; a new selection stops it.
    setFollowing(false);
    scene.setFollow(null);
  }, [selectedId]);

  const toggleFollow = () => {
    const scene = sceneRef.current;
    if (!scene || !selectedId) return;
    const next = !following;
    scene.setFollow(next ? selectedId : null);
    setFollowing(next);
  };

  const toggleFullscreen = () => {
    const root = rootRef.current;
    if (!root) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void root.requestFullscreen?.();
  };

  if (failed) return <OfficeStageFallback message={strings.noWebgl} />;

  return (
    // `isolate` keeps the per-label z-indexes local to the stage, so page dialogs (z-50) stay on top.
    <div ref={rootRef} className="absolute inset-0 isolate overflow-hidden bg-background">
      <div ref={hostRef} className="absolute inset-0" />
      <div className="pointer-events-none absolute inset-0">
        {ROOMS.map((room) => (
          <span
            key={room.id}
            ref={(element) => {
              if (element) roomRefs.current.set(room.id, element);
              else roomRefs.current.delete(room.id);
            }}
            className="absolute left-0 top-0 hidden rounded-full bg-background/70 px-2 py-0.5 text-xs font-medium text-muted-foreground"
          >
            {roomName(room.id)}
          </span>
        ))}
        {agents.map((agent) => (
          <OfficeAgentLabel
            key={agent.id}
            ref={(element) => {
              if (element) labelRefs.current.set(agent.id, element);
              else labelRefs.current.delete(agent.id);
            }}
            agent={agent}
            now={now}
            selected={agent.id === selectedId}
            onSelect={(id) => onSelect(id)}
          />
        ))}
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20000 flex justify-center px-3">
        <div className="pointer-events-auto max-w-full">
          <OfficeToolbar
            onHome={() => sceneRef.current?.focusArea("home")}
            onArea={(id) => sceneRef.current?.focusArea(id)}
            zoomPercent={zoomPercent}
            onZoom={(factor) => sceneRef.current?.zoomBy(factor)}
            onFullscreen={toggleFullscreen}
            canFollow={selectedId != null}
            following={following}
            onFollowToggle={toggleFollow}
            onAssign={() => {
              // The New issue dialog portals into <body>, which is hidden while the stage is fullscreen.
              if (document.fullscreenElement) void document.exitFullscreen();
              onAssign(null);
            }}
          />
        </div>
      </div>
    </div>
  );
}
