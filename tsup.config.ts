import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/worker.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  shims: true, // This adds __dirname compatibility for ESM modules
});
