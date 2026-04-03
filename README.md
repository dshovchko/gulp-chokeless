# gulp-chokeless

High-performance, multithreaded stream orchestrator for Gulp via Node.js `worker_threads`.

## What is this?

`gulp-chokeless` is a specialized Gulp plugin designed to offload heavy, CPU-intensive file transformations (like CSS compilation, transpilation, or minification) from the main Node.js thread to an isolated pool of background workers.

## Why reinvent the bicycle?

Gulp runs on Node.js, which is fundamentally single-threaded. In massive enterprise codebases (like large AEM projects), running tasks such as LESS compilation combined with LightningCSS minification can severely block the main Event Loop. This leads to degraded performance, slow watch tasks, and unutilized CPU cores.

We solved this by building a dedicated **multithreaded orchestrator** tailored specifically for stream pipelines:
* **True Multithreading:** Utilizes native Node.js `worker_threads` to process multiple files strictly in parallel.
* **Smart Resource Management:** Uses an encapsulated `GulpChokelessPool` and custom lock-free O(1) `FastQueue` to efficiently balance the load across CPU cores without memory leaks or race conditions.
* **Isolated State:** You can spawn multiple independent worker pools in a single Gulp pipeline without overlapping configurations.

In other words, this acts as a universal transformer that converts a standard Gulp pipe into a high-throughput, multithreaded execution pipeline. We have meticulously optimized its performance by implementing early worker initialization, warming up the AST and JIT compilers ahead of time, and leveraging Shared Memory to reduce inter-thread message-passing overhead and avoid extra structured-clone costs where possible.

**⚠️ IMPORTANT WARNING: DO NOT USE THIS EVERYWHERE!**  
Multithreading introduces **inter-thread communication overhead** — it takes time to serialize, send, and deserialize data between the main thread and worker threads. 
* **DO use it for:** CPU-intensive tasks like compiling LESS/SASS, running Babel, LightningCSS, terser, etc.
* **DO NOT use it for:** Trivial tasks like renaming files, string replacements, or simple concatenation. For simple tasks, the inter-thread messaging and structured-clone overhead can make your pipeline *slower* than running it natively on a single thread. Avoid inserting it blindly.

## Requirements

* **Node.js:** `>= 22.0.0` (optimized for the latest V8 engine features)
* **Gulp:** `>= 5.0.0`

## API & Usage Guide

To use `gulp-chokeless`, you need to split your logic into two parts: the **Gulp Task** (runs on the main thread) and the **Worker** (runs on background threads).

### 1. Create the Worker File (`worker.js`)
The worker must export an async `process` function. This is where your heavy lifting happens.

```javascript
// worker.js
import less from 'less';

export async function init() {
  // Optional: May run when the worker starts and again at the beginning of each stream
  // (for example in watch mode or after cache resets), so keep this limited to light
  // warm-up/reset work rather than expensive one-time setup.
  return 'Worker is ready!';
}

// The core function executed for every file in the Gulp stream
export async function process(contentStr, filename, sourceMapFlag, workerOptions) {
  // Use options passed from the main thread
  const lessOpts = Object.assign({}, workerOptions.less, { filename });
  const result = await less.render(contentStr, lessOpts);
  
  // You must return an object with specific keys expected by the orchestrator:
  return {
    result: result.css,           // The transformed content
    map: result.map,              // Sourcemap string (if generated)
    imports: result.imports,      // Array of imported dependencies (optional)
    extname: '.css'               // New file extension
  };
}
```

### 2. Configure the Gulp Task (`gulpfile.js`)
In your main configuration, instantiate the tool *outside* the task function so the worker pool persists between `watch` executions.

```javascript
// gulpfile.js
import gulp from 'gulp';
import path from 'path';
import gulpChokelessPool from 'gulp-chokeless';

const __dirname = import.meta.dirname;

// 1. Initialize the thread pool
const lessCompiler = gulpChokelessPool({
  workerPath: path.resolve(__dirname, './worker.js'),
  concurrency: 4, // Optional: defaults to ~75% of your CPU cores
  workerOptions: {
    // This entire object is passed to your worker's process() function
    less: { math: 'always' },
    lightningcss: { minify: true }
  }
});

// 2. Consume the pool in a standard Gulp pipeline
export function buildStyles() {
  return gulp.src('src/styles/**/*.less', { sourcemaps: true })
    // Pipe all streams into the thread pool
    .pipe(lessCompiler())
    .on('error', function(err) {
      console.error('Task failed:', err.message);
      this.emit('end'); // Prevents gulp watch from crashing!
    })
    .pipe(gulp.dest('dist/css', { sourcemaps: '.' }));
}
```

## Options

When initializing `gulpChokelessPool(options)`, you can pass:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `workerPath` | `string` | **required** | Absolute path to the worker file. |
| `concurrency`| `number` | `CPUs * 0.75` | Maximum number of concurrent worker threads to spawn. |
| `workerOptions`| `object` | `{}` | An object containing configs grouped by tool (passed directly to the worker). |

> **Note on `concurrency`:** You can specify more workers than your machine has CPU cores—nothing will break and the pipeline will still execute successfully. However, doing so will likely slow down your task due to the extra processing overhead of managing those extra workers and context switching. By default, the auto mode dynamically sets concurrency to 75% of your available logical cores (but never less than 1).

## Examples

Not sure how to wire everything together cleanly with LESS + LightningCSS + Banner injection? 

Check out the fully working boilerplate in the [`example/`](./example) directory! It demonstrates the optimal architecture for splitting operations into clean Node.js modules without cluttering the main task file.
