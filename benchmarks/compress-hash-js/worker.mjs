// gulp-chokeless worker for compress-hash-js scenario.
// Runs brotli compression + pbkdf2-sha256 on every file content
// to simulate a CPU-bound transformation (e.g. minify + integrity hash).

import {brotliCompressSync, constants} from 'node:zlib';
import {pbkdf2Sync} from 'node:crypto';

export async function init() {
  return 'compress-hash worker ready';
}

export async function process(contentStr /* , filename, sourceMapFlag, workerOptions */) {
  const buf = Buffer.from(contentStr, 'utf-8');
  // CPU intensive: Brotli compression (level 8 to keep benchmark time reasonable)
  const compressed = brotliCompressSync(buf, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 8,
    }
  });
  // CPU intensive: PBKDF2 hashing with 10k iterations
  pbkdf2Sync(compressed, 'benchmarks-salt-string', 10000, 32, 'sha256');

  // We don't actually need the transformed bytes downstream — the sink discards.
  // Returning a tiny string keeps the IPC payload realistic but small.
  return {result: ''};
}
