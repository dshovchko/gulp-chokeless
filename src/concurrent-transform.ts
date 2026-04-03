import {Transform} from 'stream';
import type {TransformCallback} from 'stream';

/**
 * Options for configuring the ConcurrentTransform stream concurrency parameters.
 */
export interface ConcurrentTransformOptions {
  /** Maximum number of tasks processed concurrently. */
  concurrency?: number;
  /** Whether the stream operates in object mode. Default true. */
  objectMode?: boolean;
  /** Custom highWaterMark parameter for underlying Transform stream buffering. */
  highWaterMark?: number;
}

/**
 * Signature for a background operation triggered concurrently against stream chunks.
 */
export type PerformTask = (chunk: any, encoding: string, callback: TransformCallback) => void;

/**
 * Signature for an optional finalizer callback to be executed before the stream flushing completes.
 */
export type FlushCallback = (callback: TransformCallback) => void;

/**
 * A custom Transform stream implementation that processes chunks explicitly
 * concurrently, guaranteeing the process remains below specified limits.
 */
export class ConcurrentTransform extends Transform {
  private concurrency: number;
  private performTask: PerformTask;
  private flushCallback?: FlushCallback;
  private activeCount = 0;
  private drainTransformCallback?: TransformCallback;
  private drainFlushCallback?: () => void;

  constructor(
    options: ConcurrentTransformOptions,
    performTask: PerformTask,
    flushCallback?: FlushCallback
  ) {
    if (typeof options === 'function') {
      flushCallback = performTask as unknown as FlushCallback;
      performTask = options as unknown as PerformTask;
      options = {};
    }
    super({
      objectMode: options.objectMode !== false,
      highWaterMark: options.highWaterMark ?? 16
    });

    this.concurrency = options.concurrency ?? 1;
    this.performTask = performTask;
    this.flushCallback = flushCallback;
  }

  _transform(chunk: any, encoding: string, callback: TransformCallback): void {
    this.activeCount++;

    this.performTask(chunk, encoding, (err?: Error | null, result?: any) => {
      this.activeCount--;

      if (err) {
        this.emit('error', err);
      } else if (result !== undefined) {
        this.push(result);
      }

      if (this.drainTransformCallback && this.activeCount < this.concurrency) {
        const drainCb = this.drainTransformCallback;
        this.drainTransformCallback = undefined;
        drainCb();
      }

      if (this.drainFlushCallback && this.activeCount === 0) {
        const flushCb = this.drainFlushCallback;
        this.drainFlushCallback = undefined;
        flushCb();
      }
    });

    if (this.activeCount < this.concurrency) {
      callback();
    } else {
      this.drainTransformCallback = callback;
    }
  }

  _flush(callback: TransformCallback): void {
    const doFlush = (): void => {
      if (typeof this.flushCallback === 'function') {
        this.flushCallback(callback);
      } else {
        callback();
      }
    };

    if (this.activeCount > 0) {
      this.drainFlushCallback = doFlush;
    } else {
      doFlush();
    }
  }
}
