
import gulp from 'gulp';
import path from 'path';
import createPool from 'gulp-chokeless';

// 1. Setup the gulp-chokeless worker pool
const lessTask = createPool({
  workerPath: path.resolve(import.meta.dirname, './worker/less.js'),
  concurrency: 4
});

// 2. Define your typical gulp task
export function buildStyles() {
  const src = 'src/styles/**/*.less';
  const destFolder = 'dist/styles';
  const enableSourcemap = true;

  return gulp.src(src, {
    allowEmpty: true,
    sourcemaps: enableSourcemap
  })
  .pipe(lessTask({
    workerOptions: {
      less: { math: 'always' },
      lightningcss: { minify: true },
      banner: { text: "/* My Gulp Plugin Banner */" }
    }
  }))
  .pipe(gulp.dest(destFolder, { sourcemaps: enableSourcemap ? '.' : false }));
}

export default buildStyles;
