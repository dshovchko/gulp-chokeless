// Gulp pipeline using gulp-chokeless to offload work to a worker pool.
import gulp from 'gulp';
import path from 'node:path';
import {Writable} from 'node:stream';
import {fileURLToPath} from 'node:url';
import createPool from '../../dist/index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const pattern = process.env.BENCH_PATTERN || 'node_modules/**/*.md';
const concurrency = process.env.CONCURRENCY ? Number(process.env.CONCURRENCY) : undefined;

const mdRender = createPool({
  workerPath: path.resolve(__dirname, './worker.mjs'),
  concurrency
});

function makeSink() {
  return new Writable({
    objectMode: true,
    write(_chunk, _enc, cb) { cb(); }
  });
}

export default function defaultTask() {
  return gulp.src(pattern, {allowEmpty: true})
    .pipe(mdRender({}))
    .pipe(makeSink());
}
