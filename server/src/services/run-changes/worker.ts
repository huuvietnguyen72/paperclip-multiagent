import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../delivery-work-notifications.js";
import { HEARTBEAT_RUN_TERMINAL_STATUSES } from "../heartbeat/recovery.js";
import { subscribeAllCompanyLiveEvents } from "../live-events.js";
import type { RunChangesService } from "./service.js";

type Coordinator = ReturnType<typeof createDeliveryWorkCoordinator>;
const TERMINAL = new Set<string>(HEARTBEAT_RUN_TERMINAL_STATUSES);

/**
 * Finalizes run-change captures once their run reaches a terminal status. The
 * existing `heartbeat.run.status` live event is published after the persisted
 * transition, so a wake always finds the terminal run.
 */
export function registerRunChangesWork(
  coordinator: Coordinator,
  service: Pick<RunChangesService, "finalizePending" | "hasPendingWork">,
) {
  const worker = coordinator.register(DELIVERY_QUEUES.runChanges, {
    retryMs: 10_000,
    async run(signal) {
      if (signal.aborted) return;
      await service.finalizePending();
    },
    hasPending: () => service.hasPendingWork(),
  });
  const unsubscribe = subscribeAllCompanyLiveEvents((event) => {
    if (event.type === "heartbeat.run.status" && TERMINAL.has(String(event.payload.status))) worker.wake();
  });
  return { ...worker, stop: () => unsubscribe() };
}
