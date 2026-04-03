
...

const less = createChokelessTask({
  workerPath: path.resolve(import.meta.dirname, './worker/less.js')
});

gulp.src(src, {
    allowEmpty: true,
    sourcemaps: enableSourcemap
  })
  .pipe(less({
    workerOptions: {
      less: lessOptions,
      lightningcss: lightningcssOptions,
      banner: { text: _banner }
    }
  }))
  .pipe(gulp.dest(destFolder, {sourcemaps: enableSourcemap ? '.' : false}));
};

...
