const gulp = require('gulp');
const path = require('path');
const createGulpWorkerPool = require('./dist/index.js').default || require('./dist/index.js');

const gulpWorker = createGulpWorkerPool({
  concurrency: 1,
  workerPath: path.resolve(__dirname, './test/dummy-error-worker.js')
});

gulp.task('default', () => {
  return gulp.src('package.json', {allowEmpty: true})
    .pipe(gulpWorker({noCrash: false}));
});
