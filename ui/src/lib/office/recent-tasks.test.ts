import { describe, expect, it } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { RECENT_TASK_LIMIT, recentTasks } from "./recent-tasks";

const issue = (id: string, updatedAt: string, extra: Record<string, unknown> = {}) =>
  ({ id, identifier: id.toUpperCase(), title: `Task ${id}`, status: "in_progress", assigneeAgentId: "be", updatedAt, hiddenAt: null, ...extra }) as unknown as Issue;

describe("recentTasks", () => {
  it("lists the most recently updated tasks first", () => {
    const tasks = recentTasks([
      issue("qua-1", "2026-11-08T10:00:00Z"),
      issue("qua-3", "2026-11-10T09:00:00Z"),
      issue("qua-2", "2026-11-09T10:00:00Z"),
    ]);
    expect(tasks.map((task) => task.identifier)).toEqual(["QUA-3", "QUA-2", "QUA-1"]);
    expect(tasks[0]).toMatchObject({ id: "qua-3", title: "Task qua-3", status: "in_progress", assigneeAgentId: "be", updatedAt: "2026-11-10T09:00:00.000Z" });
  });

  it("keeps only the most recent tasks", () => {
    const many = Array.from({ length: 20 }, (_, i) => issue(`qua-${i}`, new Date(Date.UTC(2026, 10, 1, i)).toISOString()));
    const tasks = recentTasks(many);
    expect(tasks).toHaveLength(RECENT_TASK_LIMIT);
    expect(tasks[0].identifier).toBe("QUA-19");
  });

  it("skips hidden tasks", () => {
    const tasks = recentTasks([issue("qua-1", "2026-11-10T10:00:00Z", { hiddenAt: "2026-11-10T11:00:00Z" }), issue("qua-2", "2026-11-09T10:00:00Z")]);
    expect(tasks.map((task) => task.id)).toEqual(["qua-2"]);
  });
});
