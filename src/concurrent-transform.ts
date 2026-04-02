import {Transform} from 'stream';
import type {TransformCallback} from 'stream';

export interface ConcurrentTransformOptions {
  concurrency?: number;
  objectMode?: boolean;
  highWaterMark?: number;
}

export type PerformTask = (chunk: any, encoding: string, callback: TransformCallback) => void;
export type FlushCallback = (callback: TransformCallback) => void;

export class ConcurrentTransform extends Transform {
  private concurrency: number;
  private performTask: PerformTask;
  private flushCallback?: FlushCallback;
  private activeCount = 0;
  private callbackPending = false;
  private drainCallback?: TransformCallback;

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
      highWaterMark: options.highWaterMark || 16
    });

    this.concurrency = options.concurrency || 1;
    this.performTask = performTask;
    this.flushCallback = flushCallback;
  }

  _transform(chunk: any, encoding: string, callback: TransformCallback): void {
    this.activeCount++;
    this.callbackPending = true;

    this.performTask(chunk, encoding, (err?: Error | null, result?: any) => {
      this.activeCount--;

      if (err) {
        this.emit('error', err);
      } else if (result !== undefined) {
        this.push(result);
      }

      if (this.drainCallback && this.activeCount === 0) {
        const drainCb = this.drainCallback;
        this.drainCallback = undefined;
        drainCb();
      }
    });

    if (this.activeCount < this.concurrency) {
      this.callbackPending = false;
      callback();
    } else {
      this.drainCallback = callback;
      this.callbackPending = false;
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
      this.drainCallback = doFlush;
    } else {
      doFlush();
    }
  }
}
