import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { publishLiveEvent } from "../live-events.js";
import { DELIVERY_QUEUES } from "../delivery-work-notifications.js";
import { registerRunChangesWork } from "./worker.js";

function fakeCoordinator() {
  const wake = vi.fn();
  const registered: Array<{ queue: string; task: { run: (signal: AbortSignal) => Promise<unknown>; hasPending: () => Promise<boolean> } }> = [];
  return {
    wake,
    registered,
    register: (queue: string, task: { run: (signal: AbortSignal) => Promise<unknown>; hasPending: () => Promise<boolean> }) => {
      registered.push({ queue, task });
      return { ready: Promise.resolve(), wake, stop: vi.fn() };
    },
  };
}

describe("registerRunChangesWork", () => {
  it("finalizes pending captures when it runs and reports pending work", async () => {
    const coordinator = fakeCoordinator();
    const service = { finalizePending: vi.fn(async () => 2), hasPendingWork: vi.fn(async () => true) };
    const worker = registerRunChangesWork(coordinator as never, service);
    expect(coordinator.registered[0]!.queue).toBe(DELIVERY_QUEUES.runChanges);
    await coordinator.registered[0]!.task.run(new AbortController().signal);
    expect(service.finalizePending).toHaveBeenCalledTimes(1);
    expect(await coordinator.registered[0]!.task.hasPending()).toBe(true);
    worker.stop();
  });

  it("wakes on terminal run status events only", () => {
    const coordinator = fakeCoordinator();
    const service = { finalizePending: vi.fn(async () => 0), hasPendingWork: vi.fn(async () => false) };
    const worker = registerRunChangesWork(coordinator as never, service);
    const companyId = randomUUID();
    publishLiveEvent({ companyId, type: "heartbeat.run.status", payload: { runId: randomUUID(), status: "running" } });
    expect(coordinator.wake).not.toHaveBeenCalled();
    publishLiveEvent({ companyId, type: "heartbeat.run.status", payload: { runId: randomUUID(), status: "succeeded" } });
    expect(coordinator.wake).toHaveBeenCalledTimes(1);
    worker.stop();
    publishLiveEvent({ companyId, type: "heartbeat.run.status", payload: { runId: randomUUID(), status: "failed" } });
    expect(coordinator.wake).toHaveBeenCalledTimes(1);
  });
});
