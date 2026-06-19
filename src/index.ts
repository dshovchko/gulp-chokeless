import path from 'path';
import {Worker} from 'worker_threads';
import os from 'os';
import {FastQueue} from './fast-queue';
import {ConcurrentTransform} from './concurrent-transform';
import type {EventLoopUtilization} from 'perf_hooks';

type TaskCallback = (error: Error | null, result: any) => void;

/**
 * Per-worker load statistics collected over a single stream's lifetime.
 */
export interface WorkerStats {
  /** Event loop utilization (0–1): fraction of time the worker's event loop was active during the stream. */
  utilization: number;
  /** Number of tasks (files) this worker processed during the stream. */
  tasksProcessed: number;
}

/**
 * Aggregated pool statistics for one stream, passed to the user-supplied
 * {@link StatsReporter}.
 */
export interface PoolStats {
  /** Per-worker stats, indexed by worker spawn order. */
  workers: WorkerStats[];
  /** Summary across all workers. */
  summary: {
    avgUtilization: number;
    minUtilization: number;
    maxUtilization: number;
    /** Difference between max and min utilization (0–1). */
    spread: number;
    /** Total tasks processed by the whole pool during the stream. */
    totalTasks: number;
  };
}

/**
 * User-supplied callback that receives pool statistics each time a stream
 * finishes. Runs outside the per-task hot path and is wrapped in a guard, so it
 * cannot break the pipeline if it throws.
 *
 * Note: the callback is invoked synchronously during stream cleanup; keep it
 * lightweight to avoid delaying stream completion. Provide it via the pool's
 * `onStats` option to enable stats.
 */
export type StatsReporter = (stats: PoolStats) => void;

interface WorkerInfo {
  worker: Worker;
  busy: boolean;
  callbacks: Map<number, TaskCallback>;
  /**
   * Cumulative count of tasks completed by this worker slot (spawn index). The
   * counter is carried across worker replacements (see
   * {@link GulpChokelessPool.replaceDeadWorker}) so per-stream task deltas keep
   * counting work done before a mid-stream crash.
   */
  tasksProcessed: number;
}

/**
 * A single stream's measurement window: per-worker ELU and task-count baselines
 * captured when the stream starts, so its stats can be derived as deltas.
 */
interface StatsSession {
  eluBaselines: EventLoopUtilization[];
  taskBaselines: number[];
}

/**
 * Custom error class to wrap exceptions originating from background workers inside the pool.
 */
class GulpWorkerError extends Error {
  plugin: string;
  constructor(message: string | Error) {
    super(typeof message === 'string' ? message : message.message);
    this.plugin = 'gulp-chokeless';
    this.name = 'GulpWorkerError';
    if (typeof message !== 'string') {
      Object.assign(this, message);
    }
  }
}

/**
 * Represents a reusable pool of Node.js worker threads dedicated to evaluating
 * Gulp stream buffers asynchronously on background processors.
 */
export class GulpChokelessPool {
  private workers: WorkerInfo[] = [];
  private taskQueue = new FastQueue<any>();
  private workerIdCounter = 0;
  private activeStreams = 0;
  private poolConcurrency: number;
  private baseOptions: any;
  private statsReporter?: StatsReporter;
  private activeSessions = new Set<StatsSession>();
  /** Most recent per-stream init options, used to initialize replacement workers mid-stream. */
  private lastInitOptions?: any;

  constructor(baseOptions: any = {}) {
    if (!baseOptions.workerPath) {
      throw new GulpWorkerError('workerPath is required when creating a gulp-chokeless pool');
    }
    if (typeof baseOptions.onStats === 'function') {
      this.statsReporter = baseOptions.onStats;
    }
    // Strip non-cloneable/internal fields: baseOptions is posted to workers via
    // structured clone, which would reject the onStats function.
    this.baseOptions = {...baseOptions};
    delete this.baseOptions.onStats;

    this.poolConcurrency = baseOptions.concurrency || Math.max(1, Math.floor(os.cpus().length * 0.75));

    // Calculate or reuse connection pool size
    for (let i = 0; i < this.poolConcurrency; i++) {
      this.workers.push(this.createWorker());
    }

    // Pre-initialize workers immediately upon task creation (AST and JIT caching benefits)
    this.workers.forEach((w) => w.worker.postMessage({type: 'init', options: this.baseOptions}));
  }

  private handleTaskSuccess(file: any, res: any, cb: any): void {
    file.contents = Buffer.from(res.result);

    if (res.extname) {
      file.extname = res.extname;
    }

    if (res.sourcemap) {
      res.sourcemap.file = file.relative;
      res.sourcemap.sources = res.sourcemap.sources?.map((source: string) => path.relative(file.base, source));
      file.sourceMap = res.sourcemap;
    }
    cb(null, file);
  }

  private handleTaskError(err: any, file: any, currentOptions: any, cb: any): void {
    err.message = err.message + ' in file ' + (err.filename || file.path);
    cb(new GulpWorkerError(err));
  }

  private createWorker(): WorkerInfo {
    const worker = new Worker(path.join(__dirname, 'worker.js'));
    worker.unref();

    const workerInfo: WorkerInfo = {
      worker,
      busy: false,
      callbacks: new Map(),
      tasksProcessed: 0
    };

    worker.on('message', (data: any) => {
      if (data.type === 'init_done') {
        if (data.error) throw new GulpWorkerError(`Worker initialization failed: ${data.error?.message || data.error}`);
        return;
      }

      const {id, error, result, imports, sourcemap, extname} = data;
      const cb = workerInfo.callbacks.get(id);
      if (cb) {
        workerInfo.callbacks.delete(id);
        workerInfo.busy = false;
        // Only track per-slot task counts when stats are enabled, so the
        // default hot path stays untouched.
        if (this.statsReporter) workerInfo.tasksProcessed++;
        cb(error, {result, imports, sourcemap, extname});
        this.processNextTask();
      }
    });

    worker.on('error', (err: Error) => {
      for (const [, cb] of workerInfo.callbacks.entries()) cb(err, null);
      workerInfo.callbacks.clear();
      this.replaceDeadWorker(workerInfo);
    });

    worker.on('exit', (code) => {
      const hadPendingCallbacks = workerInfo.callbacks.size > 0;
      if (hadPendingCallbacks) {
        for (const [, cb] of workerInfo.callbacks.entries()) cb(new Error(`Worker stopped with exit code ${code}`), null);
        workerInfo.callbacks.clear();
        workerInfo.busy = false;
      }
      if (code !== 0 || hadPendingCallbacks) {
        this.replaceDeadWorker(workerInfo);
      }
    });

    return workerInfo;
  }

  /**
   * Starts a per-stream measurement session: captures a zero-cost ELU baseline
   * and a task-count baseline for every worker. Returns `null` when stats are
   * disabled so the hot path stays untouched.
   */
  private startStatsSession(): StatsSession | null {
    if (!this.statsReporter) return null;
    const session: StatsSession = {
      eluBaselines: this.workers.map((w) => w.worker.performance.eventLoopUtilization()),
      taskBaselines: this.workers.map((w) => w.tasksProcessed)
    };
    this.activeSessions.add(session);
    return session;
  }

  /**
   * Closes a session, derives per-worker deltas vs the captured baselines, and
   * hands the aggregated {@link PoolStats} to the user reporter. Pure reads —
   * adds no overhead to dispatch. The reporter is invoked synchronously during
   * cleanup and guarded, so a throwing reporter cannot propagate into the
   * pipeline (though a slow one will delay stream completion).
   */
  private finishStatsSession(session: StatsSession): void {
    this.activeSessions.delete(session);
    if (!this.statsReporter) return;

    const workers: WorkerStats[] = this.workers.map((w, i) => {
      const base = session.eluBaselines[i];
      const elu = base
        ? w.worker.performance.eventLoopUtilization(base)
        : w.worker.performance.eventLoopUtilization();
      const delta = w.tasksProcessed - (session.taskBaselines[i] ?? 0);
      // Carrying the counter across replacements keeps delta >= 0; clamp defensively.
      return {utilization: elu.utilization, tasksProcessed: Math.max(0, delta)};
    });

    const utils = workers.map((m) => m.utilization);
    const minUtilization = utils.length ? Math.min(...utils) : 0;
    const maxUtilization = utils.length ? Math.max(...utils) : 0;
    const totalTasks = workers.reduce((a, m) => a + m.tasksProcessed, 0);

    const stats: PoolStats = {
      workers,
      summary: {
        avgUtilization: utils.length ? utils.reduce((a, b) => a + b, 0) / utils.length : 0,
        minUtilization,
        maxUtilization,
        spread: maxUtilization - minUtilization,
        totalTasks
      }
    };

    try {
      this.statsReporter(stats);
    } catch {
      // Stats are diagnostic only — never let them break or block the pool.
    }
  }

  private replaceDeadWorker(deadWorkerInfo: WorkerInfo): void {
    const idx = this.workers.indexOf(deadWorkerInfo);
    if (idx !== -1) {
      const replacement = this.createWorker();
      // Preserve the slot's cumulative task count so per-stream deltas still
      // include work the dead worker completed earlier in the same stream.
      replacement.tasksProcessed = deadWorkerInfo.tasksProcessed;
      this.workers[idx] = replacement;
      // While a stream is active, match the replacement to the rest of the pool
      // by reusing the most recent per-stream init options (cache reset,
      // per-stream config); otherwise fall back to the pool's base options.
      const initOptions = this.activeStreams > 0 && this.lastInitOptions
        ? this.lastInitOptions
        : this.baseOptions;
      replacement.worker.postMessage({type: 'init', options: initOptions});
      if (this.activeStreams > 0) replacement.worker.ref();
      // ELU is per worker instance and the dead worker's is unrecoverable, so
      // re-baseline only utilization for active sessions. The task baseline is
      // left intact so completed-task deltas remain accurate.
      for (const session of this.activeSessions) {
        session.eluBaselines[idx] = replacement.worker.performance.eventLoopUtilization();
      }
      this.processNextTask();
    }
  }

  private processNextTask(): void {
    while (this.taskQueue.length > 0) {
      const idleWorker = this.workers.find((w) => !w.busy);
      if (!idleWorker) break;

      const task = this.taskQueue.shift();
      this.executeTask(idleWorker, task);
    }
  }

  private executeTask(workerInfo: WorkerInfo, task: {sab: SharedArrayBuffer, filename: string, sourceMap: boolean, options: any, cb: TaskCallback}): void {
    const id = ++this.workerIdCounter;
    workerInfo.busy = true;
    workerInfo.callbacks.set(id, task.cb);
    try {
      workerInfo.worker.postMessage({
        sab: task.sab,
        filename: task.filename,
        sourceMap: task.sourceMap,
        options: task.options,
        id
      });
    } catch (err: any) {
      workerInfo.callbacks.delete(id);
      workerInfo.busy = false;

      // Re-queue the task so it gets picked up immediately by the replacement.
      this.taskQueue.unshift(task);
      this.replaceDeadWorker(workerInfo);
    }
  }

  private processTask(buffer: Buffer, filename: string, sourceMap: boolean, options: any): Promise<any> {
    const sab = new SharedArrayBuffer(buffer.length);
    const view = new Uint8Array(sab);
    view.set(buffer);

    return new Promise((resolve, reject) => {
      const task = {
        sab,
        filename,
        sourceMap,
        options,
        cb: (err: Error | null, res: any): void => {
          err ? reject(err) : resolve(res);
        }
      };

      const worker = this.workers.find((w) => !w.busy);
      if (worker) {
        this.executeTask(worker, task);
      } else {
        this.taskQueue.push(task);
      }
    });
  }

  /**
   * Marks a new stream as active and refs workers so the pool keeps the event
   * loop alive while work is in flight.
   */
  private beginStream(): void {
    this.activeStreams++;
    this.workers.forEach((w) => w.worker.ref());
  }

  /**
   * Marks a stream as finished. When no streams remain, unrefs workers so the
   * pool no longer keeps the process alive.
   */
  private endStream(): void {
    this.activeStreams--;
    if (this.activeStreams <= 0) {
      this.activeStreams = 0;
      this.workers.forEach((w) => w.worker.unref());
    }
  }

  public getPlugin(): (streamOptions?: any) => ConcurrentTransform {
    return (streamOptions: any = {}): ConcurrentTransform => {
      const currentOptions = Object.assign({
        workerOptions: {},
        sourcemap: false
      }, this.baseOptions, streamOptions);

      // Lock workerPath to the originally pre-warmed module, ignoring any stream overrides
      currentOptions.workerPath = this.baseOptions.workerPath;

      // onStats is a pool-only callback; strip it so a stray per-stream override
      // never reaches postMessage (a function would throw DataCloneError).
      delete currentOptions.onStats;

      // Remember these options so a worker replaced mid-stream is initialized
      // to the same state as the rest of the pool.
      this.lastInitOptions = currentOptions;

      // Ensure workers reset their caches and receive the latest options per stream (useful for watch mode)
      this.workers.forEach((w) => w.worker.postMessage({type: 'init', options: currentOptions}));

      this.beginStream();
      const session = this.startStatsSession();

      let streamCleanedUp = false;
      const cleanup = (): void => {
        if (streamCleanedUp) return;
        streamCleanedUp = true;
        this.endStream();
        if (session) this.finishStatsSession(session);
      };

      const stream = new ConcurrentTransform(
        {concurrency: this.poolConcurrency},
        (file: any, enc: string, cb: any) => {
          if (file.isNull()) return cb(null, file);
          if (file.isStream()) return cb(new GulpWorkerError('Streaming not supported'));

          const useSourceMap = !!(file.sourceMap || currentOptions.sourcemap);
          this.processTask(file.contents, file.path, useSourceMap, currentOptions)
            .then((res: any) => this.handleTaskSuccess(file, res, cb))
            .catch((err: any) => this.handleTaskError(err, file, currentOptions, cb));
        },
        (cb: any): void => {
          cleanup();
          cb();
        }
      );

      stream.once('close', cleanup);
      stream.once('error', cleanup);

      return stream;
    };
  }
}

/**
 * Bootstraps a scalable task pool bound to a specific worker execution script.
 * @param baseOptions - Needs an absolute `workerPath` and optional `concurrency`.
 * @returns A factory function that evaluates parallel jobs against Gulp pipeline buffers without blocking the Node.js event loop.
 */
function createGulpWorkerPool(baseOptions: any = {}): (streamOptions?: any) => ConcurrentTransform {
  const pool = new GulpChokelessPool(baseOptions);
  return pool.getPlugin();
}

export default createGulpWorkerPool;
