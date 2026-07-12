import type { PathWorkQueue } from './queue.js';

export interface WatcherShutdownOptions {
  closeWatcher: () => Promise<void>;
  queue: PathWorkQueue;
  shutdownDatabase: () => Promise<void>;
  timeoutMs?: number;
}

/** Stop event intake, flush and drain queued work, then release the database. */
export async function shutdownWatcher(options: WatcherShutdownOptions): Promise<void> {
  options.queue.stopAccepting();
  await options.closeWatcher();
  options.queue.flush();
  await options.queue.drain(options.timeoutMs);
  await options.shutdownDatabase();
}
