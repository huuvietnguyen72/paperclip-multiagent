export type DepartmentId = "executive" | "analysis" | "engineering" | "quality";
export type SharedAreaId = "meeting" | "server" | "pantry";

/** Functional departments, in display order. Roles not listed here go to engineering. */
export const DEPARTMENTS: ReadonlyArray<{ id: DepartmentId; roles: readonly string[] }> = [
  { id: "executive", roles: ["ceo", "pm"] },
  { id: "analysis", roles: ["cto", "researcher", "designer"] },
  { id: "engineering", roles: ["engineer", "devops"] },
  { id: "quality", roles: ["qa", "security"] },
];

export const SHARED_AREAS: readonly SharedAreaId[] = ["meeting", "server", "pantry"];

export function departmentForRole(role: string | null | undefined): DepartmentId {
  const match = DEPARTMENTS.find((department) => role != null && department.roles.includes(role));
  return match?.id ?? "engineering";
}
