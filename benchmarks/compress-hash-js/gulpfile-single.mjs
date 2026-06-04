// Single-threaded Gulp pipeline: same CPU work but executed inline on the main thread.
import gulp from 'gulp';
import {Transform, Writable} from 'node:stream';
import {brotliCompressSync, constants} from 'node:zlib';
import {pbkdf2Sync} from 'node:crypto';

const pattern = process.env.BENCH_PATTERN || 'node_modules/**/*.js';

function inlineCompress() {
  return new Transform({
    objectMode: true,
    transform(file, _enc, cb) {
      if (file.isNull() || !file.contents) return cb(null, file);
      try {
        const compressed = brotliCompressSync(file.contents, {
          params: {[constants.BROTLI_PARAM_QUALITY]: 8}
        });
        pbkdf2Sync(compressed, 'benchmarks-salt-string', 10000, 32, 'sha256');
      } catch (err) {
        return cb(err);
      }
      cb(null, file);
    }
  });
}

function makeSink() {
  return new Writable({
    objectMode: true,
    write(_chunk, _enc, cb) { cb(); }
  });
}

export default function defaultTask() {
  return gulp.src(pattern, {allowEmpty: true})
    .pipe(inlineCompress())
    .pipe(makeSink());
}
