import { describe, it, expect } from 'vitest';
import path from 'path';

// Note that we import from dist to verify our modular architecture works
import createGulpWorkerPool from '../dist/index';

class MockFile {
  contents: Buffer | null;
  path: string;
  relative: string;
  base: string;
  extname: string;

  constructor(options: { contents?: Buffer | null, path: string }) {
    this.contents = options.contents || null;
    this.path = options.path;
    this.relative = path.basename(options.path);
    this.base = path.dirname(options.path);
    this.extname = path.extname(options.path);
  }

  isNull() { return !this.contents; }
  isStream() { return false; }
}

const runStream = (stream: any, files: MockFile[]): Promise<MockFile[]> => {
  return new Promise((resolve, reject) => {
    const results: MockFile[] = [];
    stream.on('data', (file: MockFile) => results.push(file));
    stream.on('error', reject);
    stream.on('end', () => resolve(results));

    files.forEach(f => stream.write(f));
    stream.end();
  });
};

describe('Integration with Worker Threads', () => {
  const dummyWorkerPath = path.resolve(import.meta.dirname, 'dummy-worker.js');
  const errorWorkerPath = path.resolve(import.meta.dirname, 'dummy-error-worker.js');
  const fatalWorkerPath = path.resolve(import.meta.dirname, 'dummy-fatal-crash-worker.js');

  it('1. Fail fast on missing workerPath (without waiting for stream)', () => {
    expect(() => createGulpWorkerPool({})).toThrow('workerPath is required');
  });

  it('2. Bypass stream logic for isNull() files', async () => {
    const pool = createGulpWorkerPool({ workerPath: dummyWorkerPath, concurrency: 1 });
    const stream = pool({});

    const file = new MockFile({ path: '/null.less' });
    const out = await runStream(stream, [file]);

    expect(out).toHaveLength(1);
    expect(out[0].isNull()).toBe(true);
  });

  it('3. Runs multiple files through the stream correctly in parallel', async () => {
    const pool = createGulpWorkerPool({ workerPath: dummyWorkerPath, concurrency: 2 });
    const stream = pool({ workerOptions: { suffix: '-ADDED' }});

    const files = [
      new MockFile({ contents: Buffer.from('FILE1'), path: '/a/f1.less' }),
      new MockFile({ contents: Buffer.from('FILE2'), path: '/a/f2.less' }),
      new MockFile({ contents: Buffer.from('FILE3'), path: '/a/f3.less' }),
    ];

    const output = await runStream(stream, files);
    expect(output).toHaveLength(3);

    // Sort output to reliably check parallel execution results
    const results = output.map(f => f.contents?.toString() || '').sort();

    // Check results mapped correctly
    expect(results[0]).toBe('FILE1-ADDED');
    expect(results[1]).toBe('FILE2-ADDED');
    expect(results[2]).toBe('FILE3-ADDED');
    expect(output[0].extname).toBe('.css');
  });

  it('4. Sequential pools operate independently and in perfect isolation', async () => {
    const pool1 = createGulpWorkerPool({ workerPath: dummyWorkerPath, concurrency: 1 });
    const pool2 = createGulpWorkerPool({ workerPath: dummyWorkerPath, concurrency: 1 });

    const stream1 = pool1({ workerOptions: { suffix: '-P1' }}) as any;
    const stream2 = pool2({ workerOptions: { suffix: '-P2' }}) as any;

    return new Promise<void>((resolve, reject) => {
      const results: MockFile[] = [];
      stream1.pipe(stream2);

      stream2.on('data', (f: MockFile) => results.push(f));
      stream2.on('error', reject);
      stream2.on('end', () => {
        expect(results).toHaveLength(2);
        const out = results.map(f => f.contents?.toString() || '').sort();
        // Ensure pipelined sequential execution concatenated both suffixes
        expect(out[0]).toBe('F1-P1-P2');
        expect(out[1]).toBe('F2-P1-P2');
        resolve();
      });

      stream1.write(new MockFile({ contents: Buffer.from('F1'), path: '/f1.less' }));
      stream1.write(new MockFile({ contents: Buffer.from('F2'), path: '/f2.less' }));
      stream1.end();
    });
  });

  it('5. Emits an error to the stream instead of crashing the process on worker errors', async () => {
    const pool = createGulpWorkerPool({ workerPath: errorWorkerPath, concurrency: 1 });
    const stream = pool();

    const files = [new MockFile({ contents: Buffer.from('BAD_CODE'), path: '/crash.less' })];

    try {
      await runStream(stream, files);
      expect.unreachable('Should have thrown an error');
    } catch (e: any) {
      expect(e).toBeDefined();
      expect(e.plugin).toBe('gulp-chokeless');
      expect(e.message).toContain('Simulated worker crash');
    }
  });

  it('6. Replaces fatally crashed workers automatically so future streams do not hang', async () => {
    const pool = createGulpWorkerPool({ workerPath: fatalWorkerPath, concurrency: 1 });

    const stream1 = pool();
    const files1 = [new MockFile({ contents: Buffer.from('CRASH'), path: '/crash.less' })];

    try {
      await runStream(stream1, files1);
      expect.unreachable('Should have thrown an error');
    } catch (e: any) {
      expect(e.message).toContain('Worker stopped with exit code 1');
    }

    // Now test if the pool successfully replaced the dead worker
    const stream2 = pool();
    const files2 = [new MockFile({ contents: Buffer.from('hello'), path: '/ok.less' })];

    const out = await runStream(stream2, files2);
    expect(out).toHaveLength(1);
    expect(out[0].contents?.toString()).toBe('hello-OK');
  });

  it('7. Reports worker stats via onStats once all streams finish', async () => {
    let stats: any = null;
    const pool = createGulpWorkerPool({
      workerPath: dummyWorkerPath,
      concurrency: 2,
      onStats: (s: any) => { stats = s; }
    });
    const stream = pool({ workerOptions: { suffix: '-S' }});

    const files = [
      new MockFile({ contents: Buffer.from('A'), path: '/a.less' }),
      new MockFile({ contents: Buffer.from('B'), path: '/b.less' }),
      new MockFile({ contents: Buffer.from('C'), path: '/c.less' }),
    ];

    await runStream(stream, files);

    expect(stats).not.toBeNull();
    expect(stats.workers).toHaveLength(2);
    expect(stats.summary.totalTasks).toBe(3);

    for (const w of stats.workers) {
      expect(Number.isFinite(w.utilization)).toBe(true);
      expect(w.utilization).toBeGreaterThanOrEqual(0);
      expect(w.utilization).toBeLessThanOrEqual(1);
      expect(Number.isInteger(w.tasksProcessed)).toBe(true);
    }

    const {avgUtilization, minUtilization, maxUtilization, spread} = stats.summary;
    expect(minUtilization).toBeLessThanOrEqual(avgUtilization);
    expect(avgUtilization).toBeLessThanOrEqual(maxUtilization);
    expect(spread).toBeCloseTo(maxUtilization - minUtilization, 10);
  });

  it('8. Reports stats per stream, scoped to each stream\'s own tasks', async () => {
    const reports: any[] = [];
    const pool = createGulpWorkerPool({
      workerPath: dummyWorkerPath,
      concurrency: 2,
      onStats: (s: any) => { reports.push(s); }
    });

    const stream1 = pool({ workerOptions: { suffix: '-1' }});
    await runStream(stream1, [
      new MockFile({ contents: Buffer.from('A'), path: '/a.less' }),
      new MockFile({ contents: Buffer.from('B'), path: '/b.less' }),
    ]);

    const stream2 = pool({ workerOptions: { suffix: '-2' }});
    await runStream(stream2, [
      new MockFile({ contents: Buffer.from('C'), path: '/c.less' }),
      new MockFile({ contents: Buffer.from('D'), path: '/d.less' }),
      new MockFile({ contents: Buffer.from('E'), path: '/e.less' }),
    ]);

    // One report per stream, each counting only its own files (not cumulative).
    expect(reports).toHaveLength(2);
    expect(reports[0].summary.totalTasks).toBe(2);
    expect(reports[1].summary.totalTasks).toBe(3);
  });

  it('9. Does not collect stats when onStats is not provided', async () => {
    const pool = createGulpWorkerPool({ workerPath: dummyWorkerPath, concurrency: 1 });
    const stream = pool();
    const files = [new MockFile({ contents: Buffer.from('X'), path: '/x.less' })];

    const out = await runStream(stream, files);
    expect(out).toHaveLength(1);
    expect(out[0].contents?.toString()).toBe('X-PROCESSED');
  });

  it('10. Tolerates a stray onStats in per-stream options (no DataCloneError)', async () => {
    const pool = createGulpWorkerPool({ workerPath: dummyWorkerPath, concurrency: 1 });
    // onStats is a pool-only callback; passing it per-stream must not crash the
    // worker postMessage (a function would otherwise throw DataCloneError).
    const stream = pool({ onStats: () => {}, workerOptions: { suffix: '-Z' } });
    const files = [new MockFile({ contents: Buffer.from('Y'), path: '/y.less' })];

    const out = await runStream(stream, files);
    expect(out).toHaveLength(1);
    expect(out[0].contents?.toString()).toBe('Y-Z');
  });
});
