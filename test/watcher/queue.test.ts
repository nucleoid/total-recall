import assert from 'node:assert/strict';
import test from 'node:test';
import { PathWorkQueue } from '../../src/watcher/queue.js';
import { commitIfCurrent } from '../../src/watcher/sync.js';
import { shutdownWatcher } from '../../src/watcher/lifecycle.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test('coalesces newer generations and never overlaps work for the same canonical path', async () => {
  const first = deferred();
  const firstStarted = deferred();
  const calls: Array<{ path: string; generation: number }> = [];
  let active = 0;
  let maxActive = 0;
  const queue = new PathWorkQueue(async (filePath, work) => {
    active++;
    maxActive = Math.max(maxActive, active);
    calls.push({ path: filePath, generation: work.generation });
    if (calls.length === 1) {
      firstStarted.resolve();
      await first.promise;
    }
    active--;
  }, { debounceMs: 0 });

  queue.enqueue('./notes/../notes/example.md');
  await firstStarted.promise;
  queue.enqueue('notes/example.md');
  queue.enqueue('notes/example.md');
  first.resolve();
  await queue.drain();

  assert.equal(maxActive, 1);
  assert.deepEqual(calls.map(({ generation }) => generation), [1, 3]);
  assert.equal(calls[0].path, calls[1].path);
  assert.equal(queue.size, 0);
});

test('a byte change without an event drops stale preparation and immediately retries current bytes', async () => {
  let bytes = 'v1';
  const preparedV1 = deferred();
  const continueV1 = deferred();
  const committed: string[] = [];
  const queue = new PathWorkQueue(async (filePath, work) => {
    const prepared = bytes;
    if (prepared === 'v1') {
      preparedV1.resolve();
      await continueV1.promise;
    }
    await commitIfCurrent({
      filePath,
      preparedFingerprint: prepared,
      readFingerprint: async () => bytes,
      work,
      commit: async () => { committed.push(prepared); },
    });
  }, { debounceMs: 0 });

  queue.enqueue('example.md');
  await preparedV1.promise;
  bytes = 'v2';
  continueV1.resolve();
  await queue.drain();

  assert.deepEqual(committed, ['v2']);
});

test('an event during mutation schedules a final correcting pass', async () => {
  let bytes = 'v1';
  const transactionStarted = deferred();
  const finishTransaction = deferred();
  const committed: string[] = [];
  let queue!: PathWorkQueue;
  queue = new PathWorkQueue(async (filePath, work) => {
    const prepared = bytes;
    await commitIfCurrent({
      filePath,
      preparedFingerprint: prepared,
      readFingerprint: async () => bytes,
      work,
      commit: async () => {
        committed.push(prepared);
        if (prepared === 'v1') {
          transactionStarted.resolve();
          await finishTransaction.promise;
        }
      },
    });
  }, { debounceMs: 0 });

  queue.enqueue('example.md');
  await transactionStarted.promise;
  bytes = 'v2';
  queue.enqueue('example.md');
  finishTransaction.resolve();
  await queue.drain();

  assert.deepEqual(committed, ['v1', 'v2']);
});

test('an error is contained, releases state, and a later event succeeds', async () => {
  const errors: unknown[] = [];
  let attempts = 0;
  const queue = new PathWorkQueue(async () => {
    attempts++;
    if (attempts === 1) throw new Error('embed failed');
  }, { debounceMs: 0, onError: (error) => errors.push(error) });

  queue.enqueue('example.md');
  await queue.drain();
  assert.equal(queue.size, 0);
  queue.enqueue('example.md');
  await queue.drain();

  assert.equal(attempts, 2);
  assert.equal(errors.length, 1);
  assert.equal(queue.size, 0);
});

test('close flushes debounce work, rejects new events, and drain waits or times out', async () => {
  const release = deferred();
  let finished = false;
  const queue = new PathWorkQueue(async () => {
    await release.promise;
    finished = true;
  }, { debounceMs: 60_000 });

  queue.enqueue('example.md');
  queue.close();
  assert.equal(queue.enqueue('too-late.md'), false);
  await assert.rejects(queue.drain(5), /did not drain/);
  assert.equal(finished, false);
  release.resolve();
  await queue.drain();
  assert.equal(finished, true);
});

test('watcher shutdown closes events, drains work, and closes the database last', async () => {
  const order: string[] = [];
  const queue = new PathWorkQueue(async () => { order.push('work'); }, { debounceMs: 60_000 });
  queue.enqueue('pending.md');

  await shutdownWatcher({
    closeWatcher: async () => { order.push('watcher'); },
    queue,
    shutdownDatabase: async () => { order.push('database'); },
    timeoutMs: 100,
  });

  assert.deepEqual(order, ['watcher', 'work', 'database']);
});

test('different canonical paths may work concurrently', async () => {
  const release = deferred();
  let active = 0;
  let maxActive = 0;
  const started = deferred();
  const queue = new PathWorkQueue(async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    if (active === 2) started.resolve();
    await release.promise;
    active--;
  }, { debounceMs: 0 });

  queue.enqueue('one.md');
  queue.enqueue('two.md');
  await started.promise;
  release.resolve();
  await queue.drain();

  assert.equal(maxActive, 2);
});
