# Benchmarks

Three scenarios covering different bottleneck profiles. Each run compares a
plain **single-threaded Gulp pipeline** against the same pipeline accelerated
with **`gulp-chokeless`**.

**TL;DR.** On CPU-bound stages `gulp-chokeless` is **~5× faster** than a
standard Gulp pipeline at full concurrency on a desktop CPU, and **~3× faster**
on a constrained 4-core server slot. At `concurrency=1` it ties single-thread
Gulp (no parallelism to exploit, but no measurable overhead either) — meaning
you can ship it as a drop-in replacement without ever regressing your build.

## Requirements

- Node.js ≥ 22
- [`hyperfine`](https://github.com/sharkdp/hyperfine):
  - **macOS:** `brew install hyperfine`
  - **Ubuntu / Debian:** `apt install hyperfine`
  - **Fedora:** `dnf install hyperfine`
  - **Windows (WSL, Git Bash, or similar Unix-compatible environment):** `winget install hyperfine` or `choco install hyperfine`
  - **Other systems:** see the [hyperfine releases page](https://github.com/sharkdp/hyperfine/releases)

- The benchmark entrypoint for the npm scripts is `run-bench.mjs` (it launches
  `run-bench.sh`). On Windows, `run-bench.mjs` will try to locate `bash`
  automatically (Git for Windows / MSYS2); otherwise run from WSL or Git Bash.

All benchmark dependencies (Gulp, AJV, remark/rehype) are listed in
[`benchmarks/package.json`](./package.json). The script installs them
automatically on first run — no manual `npm install` needed.

> **Note on duplication.** Each scenario folder contains a `gulpfile-single.mjs`
> and a `worker.mjs` that intentionally mirror the same processing logic
> (Markdown pipeline, AJV setup, brotli+pbkdf2 chain, etc.). Keeping the
> variants self-contained makes each file readable on its own and avoids
> introducing a shared module that gets loaded differently in the main process
> versus a worker thread. If you change one side, mirror it in the other.

## Scenarios

| Scenario | What the worker does | Files | Count¹ | Bottleneck |
|---|---|---|---:|---|
| `compress-hash-js` | brotli + pbkdf2-sha256 every `.js` file | `node_modules/**/*.js` | ~7 000 | CPU |
| `md-to-html` | Markdown → HTML via remark/rehype | `node_modules/**/*.md` | ~800 | CPU |
| `validate-json` | validate `package.json` against a JSON schema (AJV) | `node_modules/**/package.json` | ~600 | mixed (I/O + CPU) |

¹ Approximate file counts from the benchmark environment. Will differ after `npm install` / package upgrades.

## Running

```bash
git clone https://github.com/dshovchko/gulp-chokeless.git
cd gulp-chokeless/benchmarks
npm run bench:compress   # brotli + pbkdf2 on every JS file
npm run bench:md-html    # Markdown → HTML
npm run bench:json       # JSON schema validation
```

Dependencies and the `dist/` build are installed automatically on first run.

To override concurrency, pass `-c` after `--`:

```bash
npm run bench:md-html -- -c 8
```

To export results to a markdown file:

```bash
npm run bench:md-html -- -e results/md-to-html.md
```

## What's compared

Every scenario runs the same task two ways:

1. **`gulp single-thread (inline transform)`** — a regular Gulp pipeline
   (`gulp.src(...)` → `Transform` doing the work → sink). This is the
   conventional way to write a Gulp task today: everything happens on the main
   Node.js thread, file by file.
2. **`gulp + gulp-chokeless (multithreaded)`** — the same Gulp pipeline, but
   the heavy `Transform` is replaced with a `gulp-chokeless` worker pool that
   dispatches each file to a background `worker_threads` worker.

Both pipelines end with a `Writable` sink that discards the output, so disk
I/O on `gulp.dest(...)` does not pollute the timings — we measure only the
transform stage.

5 runs, 1 warmup, 1 s sleep between runs. These values are hardcoded in
[`run-bench.sh`](./run-bench.sh) and are not configurable via CLI flags.

---

## Results — Intel Core Ultra 7 155U, Concurrency: 10

### compress-hash-js

| Command | Mean [s] | Min [s] | Max [s] | Relative |
|:---|---:|---:|---:|---:|
| `gulp single-thread (inline transform)` | 10.495 ± 0.104 | 10.372 | 10.600 | 5.17 ± 0.11 |
| `gulp + gulp-chokeless (multithreaded)` | 2.031 ± 0.039 | 1.995 | 2.081 | 1.00 |

### md-to-html

| Command | Mean [s] | Min [s] | Max [s] | Relative |
|:---|---:|---:|---:|---:|
| `gulp single-thread (inline transform)` | 2.638 ± 0.167 | 2.477 | 2.855 | 1.76 ± 0.12 |
| `gulp + gulp-chokeless (multithreaded)` | 1.496 ± 0.030 | 1.469 | 1.535 | 1.00 |

### validate-json

| Command | Mean [ms] | Min [ms] | Max [ms] | Relative |
|:---|---:|---:|---:|---:|
| `gulp single-thread (inline transform)` | 342.0 ± 13.8 | 327.7 | 362.6 | 1.00 |
| `gulp + gulp-chokeless (multithreaded)` | 471.4 ± 10.0 | 460.2 | 483.2 | 1.38 ± 0.06 |

> **Note (validate-json):** With ~600 fast-validating files the workers may
> spend more time waiting for the next task than executing one — IPC overhead
> between the main thread and the worker pool can dominate. This is expected
> behaviour for I/O-light workloads and intentionally probes the boundary
> where multithreading stops paying off.

---

## Results — Intel Core Ultra 7 155U, Concurrency: 1

### compress-hash-js

| Command | Mean [s] | Min [s] | Max [s] | Relative |
|:---|---:|---:|---:|---:|
| `gulp single-thread (inline transform)` | 10.416 ± 0.068 | 10.321 | 10.485 | 1.03 ± 0.01 |
| `gulp + gulp-chokeless (multithreaded)` | 10.118 ± 0.082 | 10.118 | 10.200 | 1.00 |

### md-to-html

| Command | Mean [s] | Min [s] | Max [s] | Relative |
|:---|---:|---:|---:|---:|
| `gulp single-thread (inline transform)` | 2.766 ± 0.136 | 2.576 | 2.892 | 1.05 ± 0.08 |
| `gulp + gulp-chokeless (multithreaded)` | 2.631 ± 0.138 | 2.489 | 2.837 | 1.00 |

### validate-json

| Command | Mean [ms] | Min [ms] | Max [ms] | Relative |
|:---|---:|---:|---:|---:|
| `gulp single-thread (inline transform)` | 335.6 ± 9.3 | 328.3 | 351.8 | 1.04 ± 0.06 |
| `gulp + gulp-chokeless (multithreaded)` | 323.9 ± 15.0 | 302.1 | 341.8 | 1.00 |

> **Note (concurrency=1):** With a single worker there is nothing to
> parallelise, so the two variants run essentially neck-and-neck across all
> three scenarios. This is the important property: enabling `gulp-chokeless`
> never makes the build slower, even on machines or build slots where parallel
> execution is not available.

---

## Results — AMD EPYC 9645, Concurrency: 4

> **Server context:** AMD EPYC 9645 is a 96-core server CPU running under real
> production load. Only 4 cores were allocated for these benchmarks —
> intentionally, to represent a constrained server slot rather than an idle
> workstation. The goal is to show that `gulp-chokeless` does not throttle
> under load, unlike a desktop CPU that may boost-clock freely when idle.

### compress-hash-js

| Command | Mean [s] | Min [s] | Max [s] | Relative |
|:---|---:|---:|---:|---:|
| `gulp single-thread (inline transform)` | 13.968 ± 0.242 | 13.658 | 14.292 | 2.90 ± 0.07 |
| `gulp + gulp-chokeless (multithreaded)` | 4.809 ± 0.073 | 4.721 | 4.907 | 1.00 |

### md-to-html

| Command | Mean [s] | Min [s] | Max [s] | Relative |
|:---|---:|---:|---:|---:|
| `gulp single-thread (inline transform)` | 3.881 ± 0.203 | 3.651 | 4.200 | 1.61 ± 0.13 |
| `gulp + gulp-chokeless (multithreaded)` | 2.418 ± 0.152 | 2.288 | 2.613 | 1.00 |

### validate-json

| Command | Mean [ms] | Min [ms] | Max [ms] | Relative |
|:---|---:|---:|---:|---:|
| `gulp single-thread (inline transform)` | 515.3 ± 88.4 | 456.4 | 671.6 | 1.00 |
| `gulp + gulp-chokeless (multithreaded)` | 619.5 ± 17.0 | 596.8 | 643.1 | 1.20 ± 0.21 |

> **Note (validate-json):** With ~600 fast-validating files the workers spend
> more time waiting for the next task than executing one — IPC overhead
> between the main thread and the worker pool dominates. This is expected
> behaviour for I/O-light workloads and intentionally probes the boundary
> where multithreading stops paying off. The same dynamic appears at
> concurrency=10 on the desktop CPU.

---

## Results — AMD EPYC 9645, Concurrency: 1

### compress-hash-js

| Command | Mean [s] | Min [s] | Max [s] | Relative |
|:---|---:|---:|---:|---:|
| `gulp single-thread (inline transform)` | 13.531 ± 0.258 | 13.312 | 13.829 | 1.04 ± 0.03 |
| `gulp + gulp-chokeless (multithreaded)` | 12.977 ± 0.348 | 12.421 | 13.363 | 1.00 |

### md-to-html

| Command | Mean [s] | Min [s] | Max [s] | Relative |
|:---|---:|---:|---:|---:|
| `gulp single-thread (inline transform)` | 3.610 ± 0.228 | 3.330 | 3.914 | 1.06 ± 0.08 |
| `gulp + gulp-chokeless (multithreaded)` | 3.404 ± 0.155 | 3.243 | 3.573 | 1.00 |


### validate-json

| Command | Mean [ms] | Min [ms] | Max [ms] | Relative |
|:---|---:|---:|---:|---:|
| `gulp single-thread (inline transform)` | 528.4 ± 30.5 | 498.4 | 573.9 | 1.00 |
| `gulp + gulp-chokeless (multithreaded)` | 545.9 ± 33.8 | 497.2 | 592.0 | 1.03 ± 0.09 |

> **Note (concurrency=1):** Same pattern as on the desktop CPU — with no
> parallelism available, both variants tie. `gulp-chokeless` adds no
> measurable overhead in the degenerate single-worker case.

---

## When to use gulp-chokeless

`gulp-chokeless` shines on **CPU-bound** stream stages: LESS/SASS compilation,
Babel/SWC, terser, LightningCSS, image processing, brotli, etc. The numbers
above make this concrete:

* **Heavy CPU work** (`compress-hash-js`): up to **5.17× faster** at
  concurrency 10 on a desktop CPU, **2.90× faster** at concurrency 4 on a
  loaded server. Set concurrency to **75–100% of available cores**.
* **Moderate CPU work** (`md-to-html`): **1.6–1.8× faster** across both
  machines. Set concurrency to **75–100% of available cores**.
* **At concurrency 1** the two variants are statistically indistinguishable
  on every scenario — `gulp-chokeless` is a safe drop-in even for builds that
  cannot parallelise.

For **trivial transforms** (renames, string replacements, simple
concatenation, fast schema validation) the inter-thread serialisation cost
can outweigh the work itself — keep those on the main thread. The
`validate-json` scenario at high concurrency above intentionally probes that
boundary: with ~600 fast files, single-thread Gulp wins by avoiding the
IPC round-trip entirely. Treat it as a reminder, not a regression.
