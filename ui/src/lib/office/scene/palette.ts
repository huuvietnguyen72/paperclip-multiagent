import { CAP_V1_COLORS } from "@paperclipai/shared/cliplab/palette-tokens";
import type { DepartmentId, SharedAreaId } from "../departments";

// Scene material colours. These are 3D surface colours, not UI chrome, so they live here rather than in
// the design-token layer (see doc/plans/2026-11-10-office-view-design.md §6).
export const SKIN_COLOR = "#f1c9a5";
export const TROUSER_COLOR = "#3b4252";
export const BACKGROUND_COLOR = "#1d2026";
export const GROUND_COLOR = "#2a2e35";
export const WALL_COLOR = "#eceae4";
export const GLASS_COLOR = "#bfd9e6";
export const DESK_COLOR = "#f4f1ea";
export const DESK_LEG_COLOR = "#8b8f96";
export const CHAIR_COLOR = "#30343c";
export const MONITOR_COLOR = "#16181d";
export const SCREEN_COLOR = "#5aa9e6";
export const PLANT_POT_COLOR = "#c46a3a";
export const PLANT_COLOR = "#4f9d55";
export const RACK_COLOR = "#23262d";
export const RACK_LIGHT_COLOR = "#47d16c";
export const COUNTER_COLOR = "#d9c9b0";
export const SOFA_COLOR = "#6d8fb3";
export const TABLE_COLOR = "#b98a5e";
export const CORRIDOR_COLOR = "#d8d4cb";
export const SELECTION_COLOR = "#f0a35e";

export const FLOOR_COLORS: Record<DepartmentId | SharedAreaId, string> = {
  executive: "#d9c3a0",
  analysis: "#cdbfa8",
  engineering: "#d4c4a6",
  quality: "#c9c2b4",
  meeting: "#c8d2d9",
  server: "#b9bec6",
  pantry: "#e3d6bf",
};

/** Character colours from the agent's avatar palette, so the 3D figure matches its avatar elsewhere. */
export function characterColors(paletteId: string, muted: boolean): { a: string; b: string } {
  const palette = CAP_V1_COLORS as Record<string, { a: string; b: string }>;
  if (muted) return palette["muted-dream"] ?? { a: "#9aa0a6", b: "#6b7075" };
  return palette[paletteId] ?? palette["coral-mint"] ?? { a: "#beffe8", b: "#ff797b" };
}
