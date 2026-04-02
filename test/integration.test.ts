import { describe, it, expect, vi } from 'vitest';
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
  const dummyWorkerPath = path.resolve(__dirname, 'dummy-worker.js');
  const errorWorkerPath = path.resolve(__dirname, 'dummy-error-worker.js');

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

  it('5. Handles worker crash/error gracefully without killing the whole suite (when noCrash=true)', async () => {
    // Suppress console.error so it doesn't pollute vitest runner output
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const pool = createGulpWorkerPool({ workerPath: errorWorkerPath, concurrency: 1 });
    const stream = pool({ noCrash: true });

    const files = [new MockFile({ contents: Buffer.from('BAD_CODE'), path: '/crash.less' })];

    // with noCrash it calls cb() essentially swallowing the broken file but saving the plugin
    const out = await runStream(stream, files);
    expect(out).toHaveLength(0); // The file was completely bypassed and dropped due to error processing

    expect(consoleSpy).toHaveBeenCalled();
    expect(consoleSpy.mock.calls[0][0]).toContain('Simulated worker crash');

    // Clean up the spy
    consoleSpy.mockRestore();
  });
});
