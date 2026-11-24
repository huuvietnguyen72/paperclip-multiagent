import type { Db } from "@paperclipai/db";
import { createProjectCodeViewService, type ProjectCodeViewService } from "./service.js";

export { createProjectCodeViewService, type ProjectCodeViewService, type ProjectCodeRefreshInput } from "./service.js";
export { registerProjectCodeViewRefresh } from "./worker.js";
export { readCloneHead, refreshClone, type CloneHead, type CloneRefresh } from "./git.js";

const shared = new WeakMap<Db, ProjectCodeViewService>();

/** One service per database so the routes and the done-task worker share the per-workspace refresh lock. */
export function projectCodeViewServiceFor(db: Db): ProjectCodeViewService {
  let service = shared.get(db);
  if (!service) {
    service = createProjectCodeViewService(db);
    shared.set(db, service);
  }
  return service;
}
