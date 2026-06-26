import {parentPort} from 'worker_threads';
import {pathToFileURL} from 'url';

let currentHandler: any = null;
let initPromise: Promise<any> | null = null;
let lastWorkerPath: string | null = null;

// Reused across every task: stateless codecs are safe to share and avoid a
// per-file allocation on the worker hot path.
const decoder = new TextDecoder('utf-8');
const encoder = new TextEncoder();

/**
 * Loads a specified user-provided processor module dynamically.
 * @param processorPath - The absolute path or file URL of the custom worker execution script.
 * @returns The resolved, executable module handler.
 */
async function getHandler(processorPath: string): Promise<any> {
  const moduleSpecifier = processorPath.startsWith('file://')
    ? processorPath
    : pathToFileURL(processorPath).href;
  const mod = await import(moduleSpecifier);
  return mod.default || mod;
}

/**
 * Re-reads worker options, invokes user-defined initializations or cache warm-ups,
 * and delegates success/failure directly to the parent stream orchestrator via port messaging.
 * @param message - Initialization payload dispatched from the `GulpChokelessPool`.
 */
function handleInitMessage(message: any): void {
  const opts = message.options || {};

  if (opts.workerPath && opts.workerPath !== lastWorkerPath) {
    lastWorkerPath = opts.workerPath;
    initPromise = (async (): Promise<void> => {
      try {
        currentHandler = await getHandler(opts.workerPath);
        if (typeof currentHandler.init === 'function') {
          const initResult = await currentHandler.init(opts.workerOptions || {});
          parentPort!.postMessage({type: 'init_done', result: initResult});
        } else {
          parentPort!.postMessage({type: 'init_done'});
        }
      } catch (err: any) {
        lastWorkerPath = null;
        // eslint-disable-next-line require-atomic-updates
        currentHandler = null;
        parentPort!.postMessage({
          type: 'init_done',
          error: err?.stack ?? err?.message ?? String(err),
        });
        throw err;
      }
    })();
  } else if (initPromise && opts.workerPath === lastWorkerPath) {
    // Already loaded module, but we should call the user's init() again to clear caches for watch mode
    initPromise = initPromise.then(async () => {
      try {
        if (typeof currentHandler.init === 'function') {
          const initResult = await currentHandler.init(opts.workerOptions || {});
          parentPort!.postMessage({type: 'init_done', result: initResult});
        } else {
          parentPort!.postMessage({type: 'init_done'});
        }
      } catch (err: any) {
        parentPort!.postMessage({
          type: 'init_done',
          error: err?.stack ?? err?.message ?? String(err),
        });
        throw err; // Ensure subsequent tasks fail if re-init fails
      }
    });
  } else {
    parentPort!.postMessage({type: 'init_done'});
  }
}

function processTaskResult(res: any, sourceMap: boolean): void {
  if (!res) {
    const empty = new Uint8Array(0);
    parentPort!.postMessage({result: empty.buffer, imports: []}, [empty.buffer]);
    return;
  }

  const resultString = res.result || res.css || res.code || (typeof res === 'string' ? res : '');
  // Encode the result once and transfer its exact-sized backing buffer to the
  // main thread (zero-copy): the parent wraps it with Buffer.from, sharing the
  // memory instead of re-serializing the string through structured clone.
  const bytes = encoder.encode(resultString);
  const obj: any = {
    result: bytes.buffer,
    imports: res.imports || []
  };

  if (res.extname) {
    obj.extname = res.extname;
  }

  if (sourceMap && res.map) {
    obj.sourcemap = typeof res.map === 'string' ? JSON.parse(res.map) : res.map;
  }

  parentPort!.postMessage(obj, [bytes.buffer]);
}

async function handleTaskMessage(message: any): Promise<void> {
  const {sab, filename, sourceMap, options} = message;

  if (initPromise) {
    try {
      await initPromise;
    } catch (err: any) {
      return parentPort!.postMessage({
        error: {
          message: `Worker initialization failed: ${err.message || err.toString()}`,
          filename
        }
      });
    }
  }

  const view = new Uint8Array(sab);
  const str = decoder.decode(view);

  if (!currentHandler) {
    return parentPort!.postMessage({error: {message: 'No workerPath defined', filename}});
  }

  try {
    const fn = (typeof currentHandler.process === 'function') ? currentHandler.process : currentHandler;
    const res = await fn(str, filename, sourceMap, options.workerOptions || {});
    processTaskResult(res, sourceMap);
  } catch (err: any) {
    parentPort!.postMessage({
      error: {
        message: err.message || err.toString(),
        line: err.line,
        filename: err.filename || filename,
        extract: err.extract
      }
    });
  }
}

if (parentPort) {
  parentPort.on('message', (message: any) => {
    if (message.type === 'init') {
      handleInitMessage(message);
    } else {
      // Intentionally not awaiting here to allow asynchronous tasks
      // (like lightningcss) to safely execute concurrently within the worker
      handleTaskMessage(message).catch((err: any) => {
        parentPort!.postMessage({
          error: {
            message: err?.message || err?.toString?.() || 'Unknown worker error',
            line: err?.line,
            filename: err?.filename || message?.filename,
            extract: err?.extract
          }
        });
      });
    }
  });
}
