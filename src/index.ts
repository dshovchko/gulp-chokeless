import path from 'path';
import {Worker} from 'worker_threads';
import os from 'os';
import {FastQueue} from './fast-queue';
import {ConcurrentTransform} from './concurrent-transform';

type TaskCallback = (error: Error | null, result: any) => void;

interface WorkerInfo {
  worker: Worker;
  busy: boolean;
  callbacks: Map<number, TaskCallback>;
}

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

export class GulpChokelessPool {
  private workers: WorkerInfo[] = [];
  private taskQueue = new FastQueue<any>();
  private workerIdCounter = 0;
  private activeStreams = 0;
  private poolConcurrency: number;
  private baseOptions: any;

  constructor(baseOptions: any = {}) {
    if (!baseOptions.workerPath) {
      throw new GulpWorkerError('workerPath is required when creating a gulp-chokeless pool');
    }
    this.baseOptions = baseOptions;

    this.poolConcurrency = baseOptions.concurrency || Math.max(1, Math.round(os.cpus().length * 0.75));

    // Calculate or reuse connection pool size
    for (let i = 0; i < this.poolConcurrency; i++) {
      this.workers.push(this.createWorker());
    }

    // Pre-initialize workers immediately upon task creation (AST and JIT caching benefits)
    this.workers.forEach((w) => w.worker.postMessage({type: 'init', options: baseOptions}));
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
    console.error(`\n \x1b[31m(!) ERROR: ${err.message}\x1b[0m\n`);
    if (err.extract) {
      console.error(`\x1b[33m${Array.isArray(err.extract) ? err.extract.join('\n') : err.extract}\x1b[0m\n`);
    }
    if (currentOptions.noCrash) {
      cb();
    } else {
      process.exit(1); // Standard CI crash
    }
  }

  private createWorker(): WorkerInfo {
    const worker = new Worker(path.join(__dirname, 'worker.js'));
    worker.unref();

    const workerInfo: WorkerInfo = {
      worker,
      busy: false,
      callbacks: new Map()
    };

    worker.on('message', (data: any) => {
      if (data.type === 'init_done') {
        // initialization handshake
        return;
      }

      const {id, error, result, imports, sourcemap, extname} = data;
      const cb = workerInfo.callbacks.get(id);
      if (cb) {
        workerInfo.callbacks.delete(id);
        workerInfo.busy = false;
        cb(error, {result, imports, sourcemap, extname});
        this.processNextTask();
      }
    });

    worker.on('error', (err: Error) => {
      for (const [, cb] of workerInfo.callbacks.entries()) {
        cb(err, null);
      }
      workerInfo.callbacks.clear();
      workerInfo.busy = false;
    });

    worker.on('exit', (code) => {
      if (code !== 0) {
        for (const [, cb] of workerInfo.callbacks.entries()) {
          cb(new Error(`Worker stopped with exit code ${code}`), null);
        }
        workerInfo.callbacks.clear();
        workerInfo.busy = false;
      }
    });

    return workerInfo;
  }

  private processNextTask(): void {
    if (this.taskQueue.length === 0) return;
    const idleWorker = this.workers.find((w) => !w.busy);
    if (idleWorker) {
      const task = this.taskQueue.shift();
      this.executeTask(idleWorker, task);
    }
  }

  private executeTask(workerInfo: WorkerInfo, task: {sab: SharedArrayBuffer, filename: string, sourceMap: boolean, options: any, cb: TaskCallback}): void {
    const id = ++this.workerIdCounter;
    workerInfo.busy = true;
    workerInfo.callbacks.set(id, task.cb);
    workerInfo.worker.postMessage({
      sab: task.sab,
      filename: task.filename,
      sourceMap: task.sourceMap,
      options: task.options,
      id
    });
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

  public getPlugin(): (streamOptions?: any) => ConcurrentTransform {
    return (streamOptions: any = {}): ConcurrentTransform => {
      const currentOptions = Object.assign({
        workerOptions: {},
        noCrash: false,
        sourcemap: false
      }, this.baseOptions, streamOptions);

      // Lock workerPath to the originally pre-warmed module, ignoring any stream overrides
      currentOptions.workerPath = this.baseOptions.workerPath;

      // Ensure workers receive the most up-to-date options for this stream chunk
      this.workers.forEach((w) => w.worker.postMessage({type: 'init', options: currentOptions}));

      this.activeStreams++;
      this.workers.forEach((w) => w.worker.ref());

      return new ConcurrentTransform(
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
          this.activeStreams--;
          if (this.activeStreams <= 0) {
            this.activeStreams = 0;
            this.workers.forEach((w) => w.worker.unref());
          }
          cb();
        }
      );
    };
  }
}

function createGulpWorkerPool(baseOptions: any = {}): (streamOptions?: any) => ConcurrentTransform {
  const pool = new GulpChokelessPool(baseOptions);
  return pool.getPlugin();
}

export default createGulpWorkerPool;
