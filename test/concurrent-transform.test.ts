import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConcurrentTransform } from '../src/concurrent-transform';

describe('ConcurrentTransform', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should transform chunks using a basic transform logic', () => {
    return new Promise<void>((resolve, reject) => {
      const results: string[] = [];
      const transform = new ConcurrentTransform(
        { concurrency: 2, objectMode: true },
        (chunk, end, cb) => {
          cb(null, chunk.toUpperCase());
        }
      );

      transform.on('data', (data) => {
        results.push(data);
      });

      transform.on('end', () => {
        try {
          expect(results).toEqual(['A', 'B', 'C']);
          resolve();
        } catch (e) {
          reject(e);
        }
      });

      transform.on('error', reject);

      transform.write('a');
      transform.write('b');
      transform.write('c');
      transform.end();
    });
  });

  it('should correctly allow configuration of highWaterMark to 0', () => {
    const transform = new ConcurrentTransform(
      { concurrency: 1, objectMode: true, highWaterMark: 0 },
      (chunk, enc, cb) => cb()
    );
    expect(transform.writableHighWaterMark).toBe(0);
  });

  it('should coerce concurrency <= 0 or NaN to 1 to prevent deadlocks', async () => {
    const runTest = (concurrency: number) => {
      return new Promise<void>((resolve, reject) => {
        const transform = new ConcurrentTransform(
          { concurrency, objectMode: true },
          (chunk, enc, cb) => cb(null, chunk)
        );

        let processed = 0;
        transform.on('data', () => processed++);
        transform.on('end', () => {
          try {
            expect(processed).toBe(1);
            resolve();
          } catch (e) {
            reject(e);
          }
        });
        transform.on('error', reject);

        transform.write('test');
        transform.end();
      });
    };

    await Promise.all([runTest(0), runTest(-5), runTest(NaN)]);
  });

  it('should correctly respect the concurrency limit', () => {
    return new Promise<void>((resolve, reject) => {
      let activeTasks = 0;
      let maxActiveTasks = 0;

      const transform = new ConcurrentTransform(
        { concurrency: 2, objectMode: true },
        (chunk, enc, cb) => {
          activeTasks++;
          if (activeTasks > maxActiveTasks) {
            maxActiveTasks = activeTasks;
          }

          setTimeout(() => {
            activeTasks--;
            cb(null, chunk);
          }, 100);
        }
      );

      transform.on('data', () => {});
      transform.on('end', () => {
        try {
          expect(maxActiveTasks).toBe(2);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
      transform.on('error', reject);

      transform.write('a');
      transform.write('b');
      transform.write('c');
      transform.write('d');
      transform.end();

      vi.runAllTimers();
    });
  });

  it('should correctly emit errors if the performTask callback yields an error', () => {
    return new Promise<void>((resolve) => {
      const transform = new ConcurrentTransform(
        { concurrency: 1, objectMode: true },
        (chunk, enc, cb) => {
          cb(new Error('Test error'));
        }
      );

      transform.on('error', (err) => {
        expect(err.message).toBe('Test error');
        resolve();
      });

      transform.write('a');
    });
  });

  it('should call _flush operations only once all active tasks are complete', () => {
    return new Promise<void>((resolve, reject) => {
      let activeTasks = 0;
      let flushCalledWhileTasksActive = false;

      const transform = new ConcurrentTransform(
        { concurrency: 2, objectMode: true },
        (chunk, enc, cb) => {
          activeTasks++;
          setTimeout(() => {
            activeTasks--;
            cb(null, chunk);
          }, 100);
        },
        (cb) => {
          if (activeTasks > 0) {
            flushCalledWhileTasksActive = true;
          }
          cb();
        }
      );

      transform.on('data', () => {});
      transform.on('end', () => {
        try {
          expect(flushCalledWhileTasksActive).toBe(false);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
      transform.on('error', reject);

      transform.write('a');
      transform.write('b');
      transform.end();

      vi.runAllTimers();
    });
  });

  it('should initialize correctly when a function is passed as the first argument', () => {
    return new Promise<void>((resolve, reject) => {
      const results: string[] = [];
      // Bypass TS strict type to test the JS fallback logic in lines 27-29
      const transform = new ConcurrentTransform(
        ((chunk, end, cb) => {
          cb(null, chunk.toUpperCase());
        }) as any,
        ((cb) => {
          results.push('flushed');
          cb();
        }) as any
      );

      transform.on('data', (data) => {
        results.push(data);
      });

      transform.on('end', () => {
        try {
          expect(results).toEqual(['FIRST', 'SECOND', 'flushed']);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
      transform.on('error', reject);

      // Need to push as Buffers/Strings if objectMode defaults to true (or relies on base config)
      transform.write('first');
      transform.write('second');
      transform.end();
    });
  });
});
