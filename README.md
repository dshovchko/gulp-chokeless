# gulp-chokeless

[![npm version](https://img.shields.io/npm/v/gulp-chokeless.svg)](https://www.npmjs.com/package/gulp-chokeless)
[![node version](https://img.shields.io/node/v/gulp-chokeless.svg)](https://www.npmjs.com/package/gulp-chokeless)
[![license](https://img.shields.io/npm/l/gulp-chokeless.svg)](https://github.com/dshovchko/gulp-chokeless/blob/main/LICENSE)

High-performance, multithreaded stream orchestrator for Gulp via Node.js `worker_threads`.

---

## Table of Contents

- [gulp-chokeless](#gulp-chokeless)
  - [Table of Contents](#table-of-contents)
  - [What is this?](#what-is-this)
  - [Why reinvent the wheel?](#why-reinvent-the-wheel)
  - [How it works](#how-it-works)
  - [Benchmarks](#benchmarks)
  - [Requirements](#requirements)
  - [Installation](#installation)
  - [API \& Usage Guide](#api--usage-guide)
  - [Options](#options)
  - [Worker Stats](#worker-stats)
  - [Examples](#examples)
  - [Links \& License](#links--license)

---

## What is this?

`gulp-chokeless` is a specialized Gulp plugin designed to offload heavy, CPU-intensive file transformations (like CSS compilation, transpilation, or minification) from the main Node.js thread to an isolated pool of background workers.

**Why "chokeless"?** By moving synchronous heavy lifting into background threads, it prevents your Node.js Event Loop from "choking" (hanging or stalling) during large builds, leaving your main pipeline fast and completely responsive.

## Why reinvent the wheel?

Gulp runs on Node.js, which is fundamentally single-threaded. In massive enterprise codebases (like large AEM projects), running tasks such as LESS compilation combined with LightningCSS minification can severely block the main Event Loop. This leads to degraded performance, slow watch tasks, and unutilized CPU cores.

The solution solves the problem by building a dedicated **multithreaded orchestrator** tailored specifically for stream pipelines:
* **True Multithreading:** Utilizes native Node.js `worker_threads` to process multiple files in parallel.
* **Smart Resource Management:** Uses an encapsulated `GulpChokelessPool` and custom linked-list O(1) `FastQueue` on the main thread to efficiently balance the load across CPU cores without memory leaks or race conditions.
* **Isolated State:** You can spawn multiple independent worker pools in a single Gulp pipeline without overlapping configurations.

In other words, this acts as a universal transformer that converts a standard Gulp pipe into a high-throughput, multithreaded execution pipeline. Performance was meticulously optimized by implementing early worker initialization, warming up the AST and JIT compilers ahead of time, and leveraging Shared Memory to reduce inter-thread message-passing overhead and avoid extra structured-clone costs where possible.

**⚠️ IMPORTANT WARNING: DO NOT USE THIS EVERYWHERE!**  
Multithreading introduces **inter-thread communication overhead** — it takes time to serialize, send, and deserialize data between the main thread and worker threads. 
* **DO use it for:** CPU-intensive tasks like compiling LESS/SASS, running Babel, LightningCSS, terser, etc.
* **DO NOT use it for:** Trivial tasks like renaming files, string replacements, or simple concatenation. For simple tasks, the inter-thread messaging and structured-clone overhead can make your pipeline *slower* than running it natively on a single thread. Avoid inserting it blindly.

## How it works

At a high level, the architecture separates stream management from heavy computation:

```text
┌───────────────────────┐
│ Main Node.js Thread   │ ◄─ gulp.src() emits files
└──────────┬────────────┘
           │ 1. Stream chunks (Vinyl files)
           ▼
┌───────────────────────┐
│ GulpChokelessPool     │ ◄─ Orchestrates workers
└──────────┬────────────┘
           │ 2. Files pushed to O(1) FastQueue
           │ 3. Tasks dispatched via IPC
           ▼
┌───────────────────────┐
│   Worker Threads      │ ◄─ Strictly parallel execution
│ ┌──────┐ ┌──────┐     │
│ │ W(1) │ │ W(2) │ ... │
│ └──────┘ └──────┘     │
└──────────┬────────────┘
           │ 4. Transformed content returned
           ▼
┌───────────────────────┐
│ Main Node.js Thread   │ ◄─ Pipeline resumes
└───────────────────────┘
           │ 5. Transformed files restored to stream
           ▼
          gulp.dest()
```

1. **Intake:** The main Gulp stream pipes files into the orchestrator.
2. **Queueing:** Files are buffered inside a custom `FastQueue` to provide O(1) enqueue/dequeue operations and avoid `array.shift()` overhead.
3. **Processing:** The pool manager assigns files to available background workers, ensuring zero Event Loop blocking on the main thread.
4. **Re-assembly:** Workers return the processed code (along with sourcemaps & new extensions) back to the main thread, which resumes the standard Gulp pipeline.

---

## Benchmarks

Benchmark scenario: process files from `node_modules` across three workload profiles
(CPU-bound brotli + pbkdf2 hashing, Markdown → HTML rendering, JSON schema validation).
Full results across Intel Core Ultra 7 155U and AMD EPYC 9645 — see [`benchmarks/README.md`](https://github.com/dshovchko/gulp-chokeless/blob/main/benchmarks/README.md).

**Quick numbers — brotli + pbkdf2-sha256, Intel Core Ultra 7 155U, c=10:**

| Approach | Mean time | vs. single-thread Gulp |
|---|---|---|
| `gulp` single-thread (inline `Transform`) | 10.5 s | baseline |
| **`gulp` + `gulp-chokeless`** | **2.0 s** | **5.2× faster** |

At `concurrency=1` the two variants tie across every scenario — `gulp-chokeless`
adds no measurable overhead, so it is a safe drop-in even for builds that
cannot parallelise.

**Choosing `concurrency`:** the optimum depends on *how heavy your transform is*,
not just on core count — and the two pull in opposite directions:

- **CPU-bound stages** (LESS/SASS, Babel/SWC, terser, LightningCSS, image
  processing): scale with your *physical performance* cores. A good starting
  point is 50-100% of cores, but more workers is not always faster — past the
  number of fast cores, extra workers only add scheduling overhead. On a 14-thread
  Intel Core Ultra 7 155U, brotli + pbkdf2 peaked around `concurrency=8` and got
  *slower* at 10-14.
- **Light / IO-bound stages** (renames, string replacements, fast schema
  validation): keep concurrency **low (1-3)**, or do the work inline on the main
  thread. Here the inter-thread serialisation cost dominates, so adding workers
  makes it monotonically *slower* — the same 155U was fastest at `concurrency=1`
  for JSON validation and 2× slower at `concurrency=14`.

> **Heads-up on hybrid CPUs** (Intel 12th gen+, Apple Silicon) and shared CI
> runners: `os.cpus().length` counts efficiency/low-power cores and Hyper-Threading
> siblings as equal to performance cores, so the `CPUs * 0.75` default can overshoot
> the real optimum on big or heterogeneous machines. The default is safe everywhere
> (it never breaks, and small machines / 2-core CI runners land on 1-2 workers
> automatically), but if you run heavy builds on many-core hardware it is worth
> setting `concurrency` explicitly after a quick measurement.

Run your own baseline and read the full analysis in [`benchmarks/README.md`](https://github.com/dshovchko/gulp-chokeless/blob/main/benchmarks/README.md):

```bash
# Requires hyperfine — install instructions in benchmarks/README.md
cd benchmarks
npm run bench:compress -- -c 8
```

## Requirements

* **Node.js:** `>= 22.0.0` (optimized for the latest V8 engine features)
* **Gulp:** `>= 5.0.0`

## Installation

```bash
npm install gulp-chokeless --save-dev
# or
yarn add gulp-chokeless -D
# or
pnpm add gulp-chokeless -D
```

## API & Usage Guide

To use `gulp-chokeless`, you need to split your logic into two parts: the **Gulp Task** (runs on the main thread) and the **Worker** (runs on background threads).

### 1. Create the Worker File (`worker.js`)
The worker must export an async `process` function. This is where your heavy lifting happens.

```javascript
// worker.js
import less from 'less';

export async function init() {
  // Optional: May run when the worker is first started/pre-warmed, and again
  // at the start of a new Gulp stream pipeline or when the worker is reinitialized.
  // This makes it useful for clearing caches during 'watch' mode rebuilds, but
  // avoid placing heavy one-time startup tasks here since it can run more than once.
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
  concurrency: 4 // Optional: defaults to ~75% of your CPU cores
});

// 2. Consume the pool in a standard Gulp pipeline
export function buildStyles() {
  return gulp.src('src/styles/**/*.less', { sourcemaps: true })
    // Pipe all streams into the thread pool
    .pipe(lessCompiler({
      workerOptions: {
        // This entire object is passed to your worker's process() function
        less: { math: 'always' },
        lightningcss: { minify: true }
      }
    }))
    .on('error', function(err) {
      console.error('Task failed:', err.message);
      // Note: Must use a regular function (not an arrow function) so 'this' refers to the stream
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
| `onStats`| `function` | `undefined` | Optional callback invoked with per-worker load stats each time a stream finishes. Enables [Worker Stats](#worker-stats). |

> **Note on `concurrency`:** You can specify more workers than your machine has CPU cores—nothing will break and the pipeline will still execute successfully. However, doing so will likely slow down your task due to the extra processing overhead of managing those extra workers and context switching. By default, the auto mode dynamically sets concurrency to 75% of your available logical cores (but never less than 1). The best value depends on how heavy your transform is — see [Choosing `concurrency`](#benchmarks) for light-vs-heavy guidance and notes on hybrid CPUs.

## Worker Stats

For debugging worker code and tuning `concurrency`, you can opt into worker load statistics by passing an `onStats` callback. It receives how busy each worker thread was and how the work was distributed, so you can spot under-utilized pools or uneven load.

The callback fires **once per stream**, right after that stream finishes — so a pool reused across several pipelines reports each one separately, scoped to that stream's own files. It runs off the per-task hot path and is guarded internally, so a throwing reporter can never break your pipeline. It is invoked synchronously during stream cleanup, so keep it lightweight to avoid delaying stream completion.

```javascript
const lessCompiler = gulpChokelessPool({
  workerPath: path.resolve(__dirname, './worker.js'),
  concurrency: 4,
  onStats: (stats) => {
    const { avgUtilization, minUtilization, maxUtilization, spread, totalTasks } = stats.summary;
    const pct = (n) => `${(n * 100).toFixed(1)}%`;

    console.log('\n--- Worker Stats ---');
    console.log(`utilization: avg=${pct(avgUtilization)} min=${pct(minUtilization)} max=${pct(maxUtilization)} spread=${(spread * 100).toFixed(1)}pp`);
    console.log(`tasks: total=${totalTasks}`);
    stats.workers.forEach((w, i) => {
      console.log(`  worker ${i}: ${pct(w.utilization)} (${w.tasksProcessed} tasks)`);
    });
  }
});
```

**Stats shape:**

```ts
interface PoolStats {
  workers: Array<{
    utilization: number;     // event loop utilization over the stream (0-1)
    tasksProcessed: number;  // files this worker handled during the stream
  }>;
  summary: {
    avgUtilization: number;
    minUtilization: number;
    maxUtilization: number;
    spread: number;          // maxUtilization - minUtilization (0-1)
    totalTasks: number;
  };
}
```

**Reading the numbers:**

| Signal | Interpretation |
|---|---|
| `utilization` near 100% | Workers are fully saturated — ideal for CPU-bound stages. |
| `utilization` below ~50% | Tasks are too light for this concurrency level — try fewer workers. |
| `spread` small | Work is evenly distributed across the pool. |
| `spread` large | Imbalance — a heavy "monster file" kept one worker busy, or too many workers for too few files. |

> `pp` = percentage points — the absolute difference between two percentages.

**How it works:** utilization comes from Node.js [`worker.performance.eventLoopUtilization()`](https://nodejs.org/api/worker_threads.html#workerperformanceeventlooputilizationutilization1-utilization2) — a zero-cost read from a `SharedArrayBuffer`. Each stream captures a per-worker baseline at start and reads the delta at finish; the only per-task cost is a single integer increment. **No overhead is added to the dispatch loop or worker execution path.**

> **Overlapping streams:** stats are measured per stream as deltas. Since concurrent streams share the same worker pool, their utilization windows overlap and the same worker activity is attributed to each. The numbers are exact for the common case of streams running one after another (e.g. sequential `gulp` tasks).

## Examples

Not sure how to wire everything together cleanly with LESS + LightningCSS + Banner injection? 

Check out the fully working boilerplate in the [`example/`](./example) directory! It demonstrates the optimal architecture for splitting operations into clean Node.js modules without cluttering the main task file.

## Links & License

- **GitHub Repository**: [dshovchko/gulp-chokeless](https://github.com/dshovchko/gulp-chokeless)
- **License**: [MIT](./LICENSE)
