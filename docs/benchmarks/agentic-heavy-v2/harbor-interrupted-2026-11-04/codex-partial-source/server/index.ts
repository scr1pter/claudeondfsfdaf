import { handleApi as routeApi } from "./api";
import { startWorkers, stopWorkers } from "./worker";

let initialized = false;

/** Initialize the durable local simulation queue once for this process. */
export function initializeBackend(): void {
  if (initialized) return;
  initialized = true;
  startWorkers();
}

/** Stop local simulation timers before a verification server exits. */
export function stopBackend(): void {
  stopWorkers();
  initialized = false;
}

/** API dispatch stays independent from static frontend delivery. */
export async function handleApi(request: Request): Promise<Response | null> {
  return routeApi(request);
}
