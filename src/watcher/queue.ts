import path from 'node:path';

export interface PathWork {
  readonly generation: number;
  isCurrent(): boolean;
  retryIfCurrent(): void;
}

export type PathWorker = (filePath: string, work: PathWork) => Promise<void>;

export interface PathWorkQueueOptions {
  debounceMs?: number;
  canonicalize?: (filePath: string) => string;
  onError?: (error: unknown, filePath: string) => void;
}

interface PathState {
  filePath: string;
  generation: number;
  timer: NodeJS.Timeout | null;
  running: boolean;
  dirty: boolean;
}

/** A debounce queue which serializes work per canonical path, not globally. */
export class PathWorkQueue {
  private readonly states = new Map<string, PathState>();
  private readonly waiters = new Set<() => void>();
  private readonly debounceMs: number;
  private readonly canonicalize: (filePath: string) => string;
  private readonly onError: (error: unknown, filePath: string) => void;
  private accepting = true;

  constructor(private readonly worker: PathWorker, options: PathWorkQueueOptions = {}) {
    this.debounceMs = options.debounceMs ?? 500;
    this.canonicalize = options.canonicalize ?? ((filePath) => path.resolve(filePath));
    this.onError = options.onError ?? ((error, filePath) => console.error(`Error processing ${filePath}:`, error));
  }

  get size(): number { return this.states.size; }

  enqueue(filePath: string): boolean {
    if (!this.accepting) return false;
    const key = this.canonicalize(filePath);
    let state = this.states.get(key);
    if (!state) {
      state = { filePath: key, generation: 0, timer: null, running: false, dirty: false };
      this.states.set(key, state);
    }
    state.generation++;
    state.dirty = true;
    if (!state.running) this.arm(key, state);
    return true;
  }

  stopAccepting(): void {
    this.accepting = false;
  }

  /** Stop accepting events and turn every pending debounce into immediate work. */
  close(): void {
    this.stopAccepting();
    this.flush();
  }

  flush(): void {
    for (const [key, state] of this.states) {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      if (!state.running && state.dirty) this.start(key, state);
    }
  }

  async drain(timeoutMs?: number): Promise<void> {
    this.flush();
    if (this.states.size === 0) return;
    const drained = new Promise<void>((resolve) => this.waiters.add(resolve));
    if (timeoutMs === undefined) return drained;
    let timer: NodeJS.Timeout;
    try {
      await Promise.race([
        drained,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Watcher queue did not drain within ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer!);
    }
  }

  private arm(key: string, state: PathState): void {
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = null;
      this.start(key, state);
    }, this.debounceMs);
  }

  private start(key: string, state: PathState): void {
    if (state.running || !state.dirty) return;
    state.running = true;
    void this.run(key, state);
  }

  private async run(key: string, state: PathState): Promise<void> {
    try {
      while (state.dirty) {
        state.dirty = false;
        const generation = state.generation;
        const work: PathWork = {
          generation,
          isCurrent: () => state.generation === generation,
          retryIfCurrent: () => {
            if (state.generation === generation) state.generation++;
            state.dirty = true;
          },
        };
        try {
          await this.worker(state.filePath, work);
        } catch (error) {
          this.onError(error, state.filePath);
          // A newer event deserves a try; otherwise a later enqueue restarts cleanly.
          if (state.generation === generation) state.dirty = false;
        }
        if (state.generation !== generation) state.dirty = true;
      }
    } finally {
      state.running = false;
      if (state.dirty) {
        this.start(key, state);
      } else if (!state.timer) {
        this.states.delete(key);
        if (this.states.size === 0) {
          for (const resolve of this.waiters) resolve();
          this.waiters.clear();
        }
      }
    }
  }
}
