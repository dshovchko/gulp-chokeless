import { describe, it, expect } from 'vitest';
import createPool from '../dist/index';
import path from 'path';
import { fileURLToPath } from 'url';

describe('Worker cache validation via init()', () => {
  it('Should reset cache value based on init() per-stream logic', async () => {
    // IMPORTANT: use dist so module path resolves properly
    const dirname = fileURLToPath(new URL('.', import.meta.url));
    const pool = createPool({ workerPath: path.resolve(dirname, 'dummy-cache-worker.js'), concurrency: 1 });

    // Fake a gulp file buffer handler
    const run = (stream) => new Promise((resolve, reject) => {
      let data = null;
      let endEvent = false;
      stream.on('data', f => data = f.contents.toString());
      stream.on('error', e => reject(e));
      stream.on('end', () => {
        endEvent = true;
        resolve(data);
      });

    // Some streams need cb logic, we wrap process as mockFile
    stream.write({
      isNull: ()=>false,
      isStream: ()=>false,
      path: '/test.ext',
      contents: Buffer.from(''),
      relative: '/test.ext',
      base: '/'
    });
    stream.end();
    });

    const v1 = await run(pool({ workerOptions: { reset: false } }));
    const v2 = await run(pool({ workerOptions: { reset: false } }));
    const v3 = await run(pool({ workerOptions: { reset: true } }));

    // First run increments cache to 1
    expect(v1).toBe('1');
    // Second run keeps cache so it increments to 2
    expect(v2).toBe('2');
    // Third run has reset=true passed to init(), so process pushes it to 1 again
    expect(v3).toBe('1');
  });
});
