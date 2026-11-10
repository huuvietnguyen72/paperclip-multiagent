import { useState } from "react";
import { ClipboardPlus, Crosshair, Home, LayoutGrid, Maximize, Minus, Plus } from "lucide-react";
import { DEPARTMENTS, SHARED_AREAS, type DepartmentId, type SharedAreaId } from "@/lib/office/departments";
import { strings } from "@/lib/office/strings";
import { cn } from "@/lib/utils";

export interface OfficeToolbarProps {
  onHome(): void;
  onArea(id: DepartmentId | SharedAreaId): void;
  zoomPercent: number;
  onZoom(factor: number): void;
  onFullscreen(): void;
  canFollow: boolean;
  following: boolean;
  onFollowToggle(): void;
  onAssign(): void;
}

const ROOM_IDS: ReadonlyArray<DepartmentId | SharedAreaId> = [...DEPARTMENTS.map((department) => department.id), ...SHARED_AREAS];
const roomLabel = (id: DepartmentId | SharedAreaId) =>
  (strings.departments as Record<string, string>)[id] ?? (strings.areas as Record<string, string>)[id] ?? id;

const iconButton =
  "inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40";

export function OfficeToolbar(props: OfficeToolbarProps) {
  const [roomsOpen, setRoomsOpen] = useState(false);
  return (
    <div className="flex flex-col items-center gap-1.5">
      {roomsOpen ? (
        <div className="flex max-w-full flex-wrap justify-center gap-1 rounded-lg border border-border bg-background/90 p-1 shadow-sm backdrop-blur-sm">
          {ROOM_IDS.map((id) => (
            <button
              key={id}
              type="button"
              data-toolbar-room={id}
              onClick={() => props.onArea(id)}
              className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {roomLabel(id)}
            </button>
          ))}
        </div>
      ) : null}
      <div className="flex items-center gap-0.5 rounded-lg border border-border bg-background/90 p-1 shadow-sm backdrop-blur-sm">
        <button type="button" data-toolbar="home" title={strings.toolbar.home} aria-label={strings.toolbar.home} onClick={props.onHome} className={iconButton}>
          <Home className="size-4" />
        </button>
        <button
          type="button"
          data-toolbar="rooms"
          title={strings.toolbar.rooms}
          aria-label={strings.toolbar.rooms}
          aria-expanded={roomsOpen}
          onClick={() => setRoomsOpen((open) => !open)}
          className={cn(iconButton, roomsOpen && "bg-accent text-foreground")}
        >
          <LayoutGrid className="size-4" />
        </button>
        <span className="mx-1 h-5 w-px bg-border" />
        <button type="button" data-toolbar="zoom-out" title={strings.toolbar.zoomOut} aria-label={strings.toolbar.zoomOut} onClick={() => props.onZoom(0.8)} className={iconButton}>
          <Minus className="size-4" />
        </button>
        <span className="w-12 text-center font-mono text-xs text-muted-foreground">{props.zoomPercent}%</span>
        <button type="button" data-toolbar="zoom-in" title={strings.toolbar.zoomIn} aria-label={strings.toolbar.zoomIn} onClick={() => props.onZoom(1.25)} className={iconButton}>
          <Plus className="size-4" />
        </button>
        <span className="mx-1 h-5 w-px bg-border" />
        <button type="button" data-toolbar="fullscreen" title={strings.toolbar.fullscreen} aria-label={strings.toolbar.fullscreen} onClick={props.onFullscreen} className={iconButton}>
          <Maximize className="size-4" />
        </button>
        <button
          type="button"
          data-toolbar="follow"
          title={strings.toolbar.follow}
          aria-label={strings.toolbar.follow}
          aria-pressed={props.following}
          disabled={!props.canFollow}
          onClick={props.onFollowToggle}
          className={cn(iconButton, props.following && "bg-accent text-foreground")}
        >
          <Crosshair className="size-4" />
        </button>
        <span className="mx-1 h-5 w-px bg-border" />
        <button
          type="button"
          data-toolbar="assign"
          onClick={props.onAssign}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ClipboardPlus className="size-4" />
          {strings.assignWork}
        </button>
      </div>
    </div>
  );
}
