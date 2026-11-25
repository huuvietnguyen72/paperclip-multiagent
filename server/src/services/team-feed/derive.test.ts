import { describe, expect, it } from "vitest";
import {
  actorFor, attributeRuns, noteExcerpt, readStatusChange, reasonFor, summarizeChanges,
  type FeedRun, type FeedStatusEvent,
} from "./derive.js";

const minute = (n: number) => new Date(Date.UTC(2026, 10, 25, 10, 0) + n * 60_000);
const run = (runId: string, start: number, end: number | null, files: FeedRun["files"] = [], status = "captured"): FeedRun =>
  ({ runId, startedAt: minute(start), endedAt: end === null ? null : minute(end), status, files });
const file = (path: string, additions: number, deletions: number) => ({ path, additions, deletions, binary: false });

describe("readStatusChange", () => {
  it("reads the previous status from changes, _previous or previousStatus", () => {
    expect(readStatusChange({ status: "done", changes: { status: { from: "in_progress", to: "done" } } })).toEqual({ from: "in_progress", to: "done" });
    expect(readStatusChange({ status: "todo", _previous: { status: "blocked" } })).toEqual({ from: "blocked", to: "todo" });
    expect(readStatusChange({ status: "blocked", previousStatus: "todo" })).toEqual({ from: "todo", to: "blocked" });
    expect(readStatusChange({ status: "todo" })).toEqual({ from: null, to: "todo" });
  });

  it("ignores rows without a status and rows that did not change it", () => {
    expect(readStatusChange({ status: "done", changes: { status: { from: "done" } } })).toBeNull();
    expect(readStatusChange({})).toBeNull();
    expect(readStatusChange(null)).toBeNull();
  });
});

describe("actorFor and reasonFor", () => {
  const names = new Map([["a1", "FE"]]);
  it("names agents, the board and the system", () => {
    expect(actorFor({ actorType: "agent", agentId: "a1" }, names)).toEqual({ kind: "agent", agentId: "a1", name: "FE" });
    expect(actorFor({ actorType: "user", agentId: null }, names)).toEqual({ kind: "board", agentId: null, name: "Board" });
    expect(actorFor({ actorType: "system", agentId: null }, names)).toEqual({ kind: "system", agentId: null, name: "System" });
    expect(actorFor({ actorType: "agent", agentId: "gone" }, names)).toEqual({ kind: "agent", agentId: "gone", name: "Agent" });
  });

  it("keeps only meaningful sources as the reason", () => {
    expect(reasonFor({ source: "comment" })).toBeNull();
    expect(reasonFor({ source: "update" })).toBeNull();
    expect(reasonFor({ source: "recovery.reconcile_configuration_incomplete" })).toBe("recovery.reconcile_configuration_incomplete");
    expect(reasonFor({})).toBeNull();
  });
});

describe("noteExcerpt", () => {
  it("turns markdown into plain text", () => {
    expect(noteExcerpt("**Đã** thêm [trang](http://x) `code`\n\n- mục")).toBe("Đã thêm trang code mục");
    expect(noteExcerpt("# Kết quả\n```ts\nconst a = 1;\n```\nxong")).toBe("Kết quả const a = 1; xong");
  });

  it("truncates long notes", () => {
    const excerpt = noteExcerpt("a".repeat(1000));
    expect(excerpt).toHaveLength(281);
    expect(excerpt.endsWith("…")).toBe(true);
  });
});

describe("attributeRuns", () => {
  const events: FeedStatusEvent[] = [
    { id: "e1", at: minute(0), to: "in_progress" },
    { id: "e2", at: minute(10), to: "in_review" },
    { id: "e3", at: minute(20), to: "done" },
  ];

  it("gives each step the runs that ended in it, and done the whole task", () => {
    const r1 = run("r1", -1, 12);
    const r2 = run("r2", 15, 18);
    const r3 = run("r3", 19, null, [], "pending");
    const shown = attributeRuns(events, [r1, r2, r3]);
    expect(shown.get("e1")).toEqual([]);
    expect(shown.get("e2")?.map((r) => r.runId)).toEqual(["r1", "r2"]);
    expect(shown.get("e3")?.map((r) => r.runId)).toEqual(["r1", "r2", "r3"]);
  });

  it("sends early runs to the first step and unfinished runs to the last", () => {
    const stepEvents = events.slice(0, 2);
    const early = run("early", -5, -2);
    const open = run("open", 11, null);
    const shown = attributeRuns(stepEvents, [early, open]);
    expect(shown.get("e1")?.map((r) => r.runId)).toEqual(["early"]);
    expect(shown.get("e2")?.map((r) => r.runId)).toEqual(["open"]);
  });
});

describe("summarizeChanges", () => {
  it("sums a path across runs and keeps the five largest", () => {
    const runs = [
      run("r1", 0, 1, [file("a.ts", 10, 2), file("b.ts", 1, 0), file("c.ts", 50, 0), file("d.ts", 3, 3)]),
      run("r2", 2, 3, [file("a.ts", 5, 1), file("e.ts", 7, 0), file("f.ts", 2, 2), file("g.ts", 0, 9)]),
    ];
    const changes = summarizeChanges(runs)!;
    expect(changes.totalFiles).toBe(7);
    expect(changes.additions).toBe(78);
    expect(changes.deletions).toBe(17);
    expect(changes.files.map((f) => f.path)).toEqual(["c.ts", "a.ts", "g.ts", "e.ts", "d.ts"]);
    expect(changes.files[1]).toEqual({ path: "a.ts", additions: 15, deletions: 3, binary: false });
    expect(changes.pending).toBe(false);
  });

  it("flags pending runs and returns null without runs", () => {
    expect(summarizeChanges([run("r", 0, null, [], "pending")])).toMatchObject({ pending: true, totalFiles: 0 });
    expect(summarizeChanges([])).toBeNull();
  });
});
