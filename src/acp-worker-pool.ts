import crypto from "node:crypto";
import { AcpProcess } from "./acp-process.js";

type RuntimeConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  model?: string;
  cleanup?: () => void;
};

type CreateRuntime = () => RuntimeConfig;

type Worker = {
  id: string;
  runtimeKey: string;
  runtimeConfig: RuntimeConfig;
  runner: AcpProcess;
  init: any;
  busy: boolean;
  closed: boolean;
  createdAt: number;
  lastUsedAt: number;
  requestCount: number;
  stickyRefs: Set<string>;
};

type Bucket = {
  runtimeKey: string;
  workers: Map<string, Worker>;
  queue: QueueItem[];
  creating: number;
  scaling: boolean;
  createRuntime: CreateRuntime | null;
};

type QueueItem = {
  preferredWorkerId: string;
  createdAt: number;
  signal: AbortSignal | null;
  timer: NodeJS.Timeout | null;
  abortHandler: (() => void) | null;
  resolve: (value: { worker: Worker; queuedMs: number; createdWorker: boolean }) => void;
  reject: (reason?: unknown) => void;
};

type StickySession = {
  routerSessionId: string;
  runtimeKey: string;
  workerId: string;
  acpSessionId: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
};

type AcquireResult = {
  worker: Worker;
  queuedMs: number;
  createdWorker: boolean;
};

type AcquireInput = {
  runtimeKey: string;
  createRuntime: CreateRuntime;
  preferredWorkerId?: string;
  signal?: AbortSignal;
  waitTimeoutMs?: number;
};

type PoolOptions = {
  maxSize?: number;
  minSize?: number;
  idleTtlMs?: number;
  stickyTtlMs?: number;
  acquireTimeoutMs?: number;
  maxQueue?: number;
  maxRequestsPerWorker?: number;
  reaperIntervalMs?: number;
};

function now(): number {
  return Date.now();
}

function asPositiveInt(value: unknown, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return fallback;
  }
  return Math.floor(numeric);
}

function toError(message: string, cause?: unknown): Error {
  const err = new Error(message);
  if (cause !== undefined) {
    (err as Error & { cause?: unknown }).cause = cause;
  }
  return err;
}

function describeErrorChain(err: unknown, limit = 4): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; current && depth < limit; depth += 1) {
    if (current instanceof Error) {
      if (current.message) {
        parts.push(current.message);
      }
      current = (current as Error & { cause?: unknown }).cause;
      continue;
    }
    if (typeof current === "string" && current.trim()) {
      parts.push(current.trim());
    }
    break;
  }
  if (parts.length === 0) {
    return "";
  }
  return parts.join(" <- ");
}

function removeFromArray<T>(items: T[], item: T): void {
  const index = items.indexOf(item);
  if (index >= 0) {
    items.splice(index, 1);
  }
}

export class AcpWorkerPool {
  private readonly maxSize: number;
  private readonly minSize: number;
  private readonly idleTtlMs: number;
  private readonly stickyTtlMs: number;
  private readonly acquireTimeoutMs: number;
  private readonly maxQueue: number;
  private readonly maxRequestsPerWorker: number;
  private readonly reaperIntervalMs: number;

  private readonly buckets = new Map<string, Bucket>();
  private readonly workerById = new Map<string, Worker>();
  private readonly stickySessions = new Map<string, StickySession>();
  private closed = false;
  private readonly reaperTimer: NodeJS.Timeout;

  constructor(options: PoolOptions = {}) {
    this.maxSize = Math.max(1, asPositiveInt(options.maxSize, 2));
    this.minSize = Math.min(
      this.maxSize,
      Math.max(0, asPositiveInt(options.minSize, 0))
    );
    this.idleTtlMs = Math.max(1000, asPositiveInt(options.idleTtlMs, 300000));
    this.stickyTtlMs = Math.max(1000, asPositiveInt(options.stickyTtlMs, 1800000));
    this.acquireTimeoutMs = Math.max(
      1000,
      asPositiveInt(options.acquireTimeoutMs, 30000)
    );
    this.maxQueue = Math.max(1, asPositiveInt(options.maxQueue, 256));
    this.maxRequestsPerWorker = Math.max(
      1,
      asPositiveInt(options.maxRequestsPerWorker, 200)
    );
    this.reaperIntervalMs = Math.max(
      1000,
      asPositiveInt(options.reaperIntervalMs, 10000)
    );

    this.reaperTimer = setInterval(() => {
      void this.reap();
    }, this.reaperIntervalMs);
    this.reaperTimer.unref?.();
  }

  private getBucket(runtimeKey: string): Bucket {
    let bucket = this.buckets.get(runtimeKey);
    if (!bucket) {
      bucket = {
        runtimeKey,
        workers: new Map(),
        queue: [],
        creating: 0,
        scaling: false,
        createRuntime: null
      };
      this.buckets.set(runtimeKey, bucket);
    }
    return bucket;
  }

  private isWorkerIdle(worker: Worker): boolean {
    return !worker.busy && !worker.closed;
  }

  private canCreateWorker(bucket: Bucket): boolean {
    return bucket.workers.size + bucket.creating < this.maxSize;
  }

  private getWorker(workerId: string): Worker | null {
    return this.workerById.get(workerId) || null;
  }

  async createWorker(runtimeKey: string, createRuntime: CreateRuntime): Promise<Worker> {
    const bucket = this.getBucket(runtimeKey);
    bucket.creating += 1;

    const workerId = `wrk_${crypto.randomUUID().replace(/-/g, "")}`;
    let runtimeConfig: RuntimeConfig | null = null;
    let runner: AcpProcess | null = null;
    try {
      runtimeConfig = createRuntime();
      runner = new AcpProcess({
        ...runtimeConfig,
        onUpdate: null
      });
      await runner.start();
      const init = await runner.initialize();

      const worker: Worker = {
        id: workerId,
        runtimeKey,
        runtimeConfig,
        runner,
        init,
        busy: false,
        closed: false,
        createdAt: now(),
        lastUsedAt: now(),
        requestCount: 0,
        stickyRefs: new Set()
      };
      bucket.workers.set(worker.id, worker);
      this.workerById.set(worker.id, worker);
      return worker;
    } catch (err) {
      if (runner) {
        try {
          await runner.close();
        } catch {
          // Ignore close failure.
        }
      }
      if (runtimeConfig?.cleanup) {
        try {
          runtimeConfig.cleanup();
        } catch {
          // Ignore cleanup failure.
        }
      }
      const commandHint =
        runtimeConfig?.command && String(runtimeConfig.command).trim()
          ? ` command=${runtimeConfig.command}.`
          : "";
      const details = describeErrorChain(err);
      const detailSuffix = details ? ` cause=${details}` : "";
      throw toError(
        `Failed to create ACP worker for ${runtimeKey}.${commandHint}${detailSuffix}`,
        err
      );
    } finally {
      bucket.creating -= 1;
    }
  }

  private pickIdleWorker(bucket: Bucket, preferredWorkerId = ""): Worker | null {
    if (preferredWorkerId) {
      const worker = bucket.workers.get(preferredWorkerId);
      if (worker && this.isWorkerIdle(worker)) {
        return worker;
      }
      return null;
    }

    let selected: Worker | null = null;
    for (const worker of bucket.workers.values()) {
      if (!this.isWorkerIdle(worker)) {
        continue;
      }
      if (!selected || worker.lastUsedAt < selected.lastUsedAt) {
        selected = worker;
      }
    }
    return selected;
  }

  private markWorkerBusy(worker: Worker): void {
    if (!worker || worker.closed) {
      throw new Error("Worker is unavailable.");
    }
    worker.busy = true;
    worker.lastUsedAt = now();
  }

  private markWorkerIdle(worker: Worker): void {
    if (!worker || worker.closed) {
      return;
    }
    worker.busy = false;
    worker.lastUsedAt = now();
  }

  private cleanupQueueEntry(bucket: Bucket, queueItem: QueueItem | null | undefined): void {
    if (!queueItem) {
      return;
    }
    if (queueItem.timer) {
      clearTimeout(queueItem.timer);
    }
    if (queueItem.signal && queueItem.abortHandler) {
      queueItem.signal.removeEventListener("abort", queueItem.abortHandler);
    }
    removeFromArray(bucket.queue, queueItem);
  }

  private dispatchQueue(bucket: Bucket | undefined): void {
    if (!bucket || bucket.queue.length === 0) {
      return;
    }

    for (;;) {
      let matchedIndex = -1;
      let matchedWorker: Worker | null = null;

      for (let i = 0; i < bucket.queue.length; i += 1) {
        const queueItem = bucket.queue[i];
        if (queueItem.signal?.aborted) {
          this.cleanupQueueEntry(bucket, queueItem);
          queueItem.reject(new Error("Request aborted while waiting for worker."));
          i -= 1;
          continue;
        }
        const worker = this.pickIdleWorker(bucket, queueItem.preferredWorkerId);
        if (!worker) {
          continue;
        }
        matchedIndex = i;
        matchedWorker = worker;
        break;
      }

      if (matchedIndex === -1 || !matchedWorker) {
        break;
      }

      const queueItem = bucket.queue[matchedIndex];
      this.cleanupQueueEntry(bucket, queueItem);
      this.markWorkerBusy(matchedWorker);
      queueItem.resolve({
        worker: matchedWorker,
        queuedMs: now() - queueItem.createdAt,
        createdWorker: false
      });
    }

    this.scheduleScale(bucket);
  }

  private scheduleScale(bucket: Bucket | undefined): void {
    if (!bucket || bucket.scaling || bucket.queue.length === 0) {
      return;
    }
    if (!this.canCreateWorker(bucket) || typeof bucket.createRuntime !== "function") {
      return;
    }

    const nextQueueItem = bucket.queue.find(
      (queueItem) => !queueItem.preferredWorkerId
    );
    if (!nextQueueItem) {
      return;
    }

    bucket.scaling = true;
    void this.createWorker(bucket.runtimeKey, bucket.createRuntime)
      .then((worker) => {
        if (worker.closed) {
          return;
        }
        this.dispatchQueue(bucket);
      })
      .catch(() => {
        // Keep existing queued requests; they will timeout with clear error.
      })
      .finally(() => {
        bucket.scaling = false;
        if (bucket.queue.length > 0) {
          this.scheduleScale(bucket);
        }
      });
  }

  private enqueueAcquire({
    bucket,
    preferredWorkerId,
    signal,
    waitTimeoutMs
  }: {
    bucket: Bucket;
    preferredWorkerId: string;
    signal?: AbortSignal;
    waitTimeoutMs?: number;
  }): Promise<AcquireResult> {
    if (bucket.queue.length >= this.maxQueue) {
      throw new Error("ACP worker queue is full.");
    }

    return new Promise((resolve, reject) => {
      const queueItem: QueueItem = {
        preferredWorkerId: preferredWorkerId || "",
        createdAt: now(),
        signal: signal || null,
        timer: null,
        abortHandler: null,
        resolve,
        reject
      };

      const timeoutMs = Math.max(100, waitTimeoutMs || this.acquireTimeoutMs);
      queueItem.timer = setTimeout(() => {
        this.cleanupQueueEntry(bucket, queueItem);
        reject(
          new Error(
            `Timed out waiting for an available ACP worker (${timeoutMs}ms).`
          )
        );
      }, timeoutMs);

      if (signal) {
        queueItem.abortHandler = () => {
          this.cleanupQueueEntry(bucket, queueItem);
          reject(new Error("Request aborted while waiting for worker."));
        };
        signal.addEventListener("abort", queueItem.abortHandler, { once: true });
      }

      bucket.queue.push(queueItem);
    });
  }

  async acquire({
    runtimeKey,
    createRuntime,
    preferredWorkerId = "",
    signal,
    waitTimeoutMs
  }: AcquireInput): Promise<AcquireResult> {
    if (this.closed) {
      throw new Error("ACP worker pool is closed.");
    }

    const bucket = this.getBucket(runtimeKey);
    bucket.createRuntime = createRuntime;
    this.expireStickySessions();

    let worker = this.pickIdleWorker(bucket, preferredWorkerId);
    if (worker) {
      this.markWorkerBusy(worker);
      return {
        worker,
        queuedMs: 0,
        createdWorker: false
      };
    }

    if (this.canCreateWorker(bucket)) {
      worker = await this.createWorker(runtimeKey, createRuntime);
      this.markWorkerBusy(worker);
      return {
        worker,
        queuedMs: 0,
        createdWorker: true
      };
    }

    return this.enqueueAcquire({
      bucket,
      preferredWorkerId,
      signal,
      waitTimeoutMs
    });
  }

  async release(worker: Worker | null | undefined, { destroy = false } = {}): Promise<void> {
    if (!worker) {
      return;
    }

    if (destroy) {
      await this.destroyWorker(worker, "released_with_destroy");
      return;
    }

    worker.requestCount += 1;
    this.markWorkerIdle(worker);

    if (
      worker.requestCount >= this.maxRequestsPerWorker &&
      worker.stickyRefs.size === 0
    ) {
      await this.destroyWorker(worker, "max_requests_reached");
      return;
    }

    const bucket = this.buckets.get(worker.runtimeKey);
    this.dispatchQueue(bucket);
  }

  createStickySession({
    runtimeKey,
    workerId,
    acpSessionId
  }: {
    runtimeKey: string;
    workerId: string;
    acpSessionId: string;
  }): StickySession {
    const worker = this.workerById.get(workerId);
    if (!worker || worker.runtimeKey !== runtimeKey || worker.closed) {
      throw new Error("Cannot create sticky session: worker is unavailable.");
    }

    const routerSessionId = `s_${crypto.randomUUID().replace(/-/g, "")}`;
    const timestamp = now();
    const sticky: StickySession = {
      routerSessionId,
      runtimeKey,
      workerId,
      acpSessionId,
      createdAt: timestamp,
      updatedAt: timestamp,
      expiresAt: timestamp + this.stickyTtlMs
    };
    this.stickySessions.set(routerSessionId, sticky);
    worker.stickyRefs.add(routerSessionId);
    return sticky;
  }

  updateStickySession(
    routerSessionId: string,
    updates: Partial<Pick<StickySession, "acpSessionId">>
  ): StickySession | null {
    const sticky = this.stickySessions.get(routerSessionId);
    if (!sticky) {
      return null;
    }
    const worker = this.getWorker(sticky.workerId);
    if (!worker || worker.closed || worker.runtimeKey !== sticky.runtimeKey) {
      this.deleteStickySession(routerSessionId);
      return null;
    }
    if (updates.acpSessionId) {
      sticky.acpSessionId = updates.acpSessionId;
    }
    sticky.updatedAt = now();
    sticky.expiresAt = sticky.updatedAt + this.stickyTtlMs;
    return sticky;
  }

  getStickySession(routerSessionId: string): StickySession | null {
    const sticky = this.stickySessions.get(routerSessionId);
    if (!sticky) {
      return null;
    }
    if (sticky.expiresAt <= now()) {
      this.deleteStickySession(routerSessionId);
      return null;
    }

    const worker = this.getWorker(sticky.workerId);
    if (!worker || worker.closed || worker.runtimeKey !== sticky.runtimeKey) {
      this.deleteStickySession(routerSessionId);
      return null;
    }

    sticky.updatedAt = now();
    sticky.expiresAt = sticky.updatedAt + this.stickyTtlMs;
    return sticky;
  }

  deleteStickySession(routerSessionId: string): boolean {
    const sticky = this.stickySessions.get(routerSessionId);
    if (!sticky) {
      return false;
    }
    this.stickySessions.delete(routerSessionId);
    const worker = this.getWorker(sticky.workerId);
    if (worker) {
      worker.stickyRefs.delete(routerSessionId);
    }
    return true;
  }

  private expireStickySessions(): void {
    const timestamp = now();
    for (const [routerSessionId, sticky] of this.stickySessions.entries()) {
      if (sticky.expiresAt <= timestamp) {
        this.deleteStickySession(routerSessionId);
      }
    }
  }

  private async destroyWorker(worker: Worker, _reason: string): Promise<void> {
    if (!worker || worker.closed) {
      return;
    }
    worker.closed = true;
    worker.busy = false;

    for (const stickySessionId of [...worker.stickyRefs]) {
      this.deleteStickySession(stickySessionId);
    }

    const bucket = this.buckets.get(worker.runtimeKey);
    if (bucket) {
      bucket.workers.delete(worker.id);
    }
    this.workerById.delete(worker.id);

    try {
      await worker.runner.close();
    } catch {
      // Ignore close failures.
    }

    if (worker.runtimeConfig.cleanup) {
      try {
        worker.runtimeConfig.cleanup();
      } catch {
        // Ignore cleanup failure.
      }
    }

    if (bucket) {
      this.dispatchQueue(bucket);
    }
  }

  async reap(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.expireStickySessions();

    const timestamp = now();
    const destroyTasks: Promise<void>[] = [];
    for (const bucket of this.buckets.values()) {
      const workers = [...bucket.workers.values()];
      const idleWorkers = workers.filter(
        (worker) => this.isWorkerIdle(worker) && worker.stickyRefs.size === 0
      );
      const keepIdle = Math.max(this.minSize, 0);
      const excessIdle = idleWorkers
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt)
        .filter((_, index) => index < Math.max(0, idleWorkers.length - keepIdle));

      for (const worker of excessIdle) {
        if (timestamp - worker.lastUsedAt < this.idleTtlMs) {
          continue;
        }
        destroyTasks.push(this.destroyWorker(worker, "idle_ttl"));
      }
    }
    if (destroyTasks.length > 0) {
      await Promise.allSettled(destroyTasks);
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    clearInterval(this.reaperTimer);

    const workers = [...this.workerById.values()];
    await Promise.allSettled(
      workers.map((worker) => this.destroyWorker(worker, "pool_closed"))
    );

    for (const bucket of this.buckets.values()) {
      for (const queueItem of [...bucket.queue]) {
        this.cleanupQueueEntry(bucket, queueItem);
        queueItem.reject(new Error("ACP worker pool was closed."));
      }
    }

    this.buckets.clear();
    this.workerById.clear();
    this.stickySessions.clear();
  }

  getStats(): {
    enabled: true;
    maxSize: number;
    minSize: number;
    acquireTimeoutMs: number;
    buckets: Array<{
      runtimeKey: string;
      workerCount: number;
      creating: number;
      queueSize: number;
      workers: Array<{
        id: string;
        busy: boolean;
        closed: boolean;
        requestCount: number;
        stickyRefs: number;
        ageMs: number;
        idleMs: number;
      }>;
    }>;
    stickySessionCount: number;
    stickySessions: Array<{
      routerSessionId: string;
      runtimeKey: string;
      workerId: string;
      acpSessionId: string;
      ageMs: number;
      ttlMs: number;
    }>;
  } {
    const timestamp = now();
    return {
      enabled: true,
      maxSize: this.maxSize,
      minSize: this.minSize,
      acquireTimeoutMs: this.acquireTimeoutMs,
      buckets: [...this.buckets.values()].map((bucket) => ({
        runtimeKey: bucket.runtimeKey,
        workerCount: bucket.workers.size,
        creating: bucket.creating,
        queueSize: bucket.queue.length,
        workers: [...bucket.workers.values()].map((worker) => ({
          id: worker.id,
          busy: worker.busy,
          closed: worker.closed,
          requestCount: worker.requestCount,
          stickyRefs: worker.stickyRefs.size,
          ageMs: timestamp - worker.createdAt,
          idleMs: timestamp - worker.lastUsedAt
        }))
      })),
      stickySessionCount: this.stickySessions.size,
      stickySessions: [...this.stickySessions.values()].map((sticky) => ({
        routerSessionId: sticky.routerSessionId,
        runtimeKey: sticky.runtimeKey,
        workerId: sticky.workerId,
        acpSessionId: sticky.acpSessionId,
        ageMs: timestamp - sticky.createdAt,
        ttlMs: Math.max(0, sticky.expiresAt - timestamp)
      }))
    };
  }
}
