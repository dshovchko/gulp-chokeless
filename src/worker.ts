import {parentPort} from 'worker_threads';
import {pathToFileURL} from 'url';

let currentHandler: any = null;
let initPromise: Promise<any> | null = null;
let lastWorkerPath: string | null = null;
// Cached per-stream worker options (set on init) so each task message need not
// re-clone the (potentially large) options object across the worker boundary.
let currentWorkerOptions: any = {};

// Reused across every task: stateless codecs are safe to share and avoid a
// per-file allocation on the worker hot path.
const decoder = new TextDecoder('utf-8');
const encoder = new TextEncoder();

/**
 * Recursively freezes an object graph so cached, cross-task-shared state
 * (currently {@link currentWorkerOptions}) can't be mutated by a processor.
 * Guards against cycles via `seen` so a self-referencing options object can't
 * cause infinite recursion.
 * @param value - The value to freeze in place.
 * @param seen - Objects already frozen in this call tree (cycle guard).
 */
function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  seen.add(value);
  Object.freeze(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    const child = (value as any)[key];
    if (child !== null && typeof child === 'object' && !seen.has(child)) {
      deepFreeze(child, seen);
    }
  }
  return value;
}

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

  // Cache workerOptions here (per stream / per watch reconfig) so the task hot
  // path can read them locally instead of the main thread cloning them on every
  // postMessage. Deep-frozen (cycle-safe) since it's reused across the whole
  // stream now: a per-task clone used to stop a processor's mutation (incl.
  // nested objects) from leaking into later files; freezing the whole graph
  // preserves that guarantee for the cached object.
  currentWorkerOptions = deepFreeze(opts.workerOptions || {});

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

/**
 * Converts a processor's result into bytes safe to transfer to the main
 * thread. Strings are encoded once (always producing a freshly-allocated,
 * exact-sized buffer, safe to transfer). Binary results (`Buffer`/`Uint8Array`/
 * `ArrayBuffer`) are passed through zero-copy when the view owns its entire
 * backing buffer; a view into a larger/shared buffer (e.g. a `Buffer` slice
 * from Node's shared allocation pool) is copied first, since transferring the
 * whole backing buffer would detach memory other data may still be using.
 * @param value - The raw result value returned by the user's `process()`.
 */
function toTransferableBytes(value: any): Uint8Array {
  if (typeof value === 'string') return encoder.encode(value);
  if (value instanceof Uint8Array) {
    // A SharedArrayBuffer-backed view must always be copied: returning it
    // as-is would let the main thread's Buffer.from wrap shared memory
    // instead of a private copy, and it also isn't Transferable.
    const isShared = typeof SharedArrayBuffer !== 'undefined' && value.buffer instanceof SharedArrayBuffer;
    if (!isShared && value.byteOffset === 0 && value.byteLength === value.buffer.byteLength) {
      return value;
    }
    // Note: Buffer (a Uint8Array subclass) overrides .slice() to return a
    // VIEW into the same backing buffer instead of copying, so call the base
    // Uint8Array.prototype.slice explicitly to guarantee an independent,
    // exact-sized copy here (always ArrayBuffer-backed, even when the source
    // view is backed by a SharedArrayBuffer).
    return Uint8Array.prototype.slice.call(value);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return encoder.encode(String(value ?? ''));
}

/**
 * Posts a message whose payload bytes live in `bytes.buffer`, transferring
 * that buffer (zero-copy) only when it is a real `ArrayBuffer`. Belt-and-
 * suspenders: {@link toTransferableBytes} already guarantees an ArrayBuffer-
 * backed result, but if it were ever handed a SharedArrayBuffer directly this
 * still falls back to a normal (copying) postMessage instead of throwing.
 */
function postWithBytes(obj: any, bytes: Uint8Array): void {
  const buffer = bytes.buffer;
  if (buffer instanceof ArrayBuffer) {
    parentPort!.postMessage(obj, [buffer]);
  } else {
    parentPort!.postMessage(obj);
  }
}

function processTaskResult(res: any, sourceMap: boolean): void {
  if (!res) {
    const empty = new Uint8Array(0);
    postWithBytes({result: empty.buffer, imports: []}, empty);
    return;
  }

  const rawResult = res.result || res.css || res.code || (typeof res === 'string' ? res : '');
  // Encode/normalize the result once and transfer its exact-sized backing
  // buffer to the main thread (zero-copy): the parent wraps it with
  // Buffer.from, sharing the memory instead of re-serializing through
  // structured clone.
  const bytes = toTransferableBytes(rawResult);
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

  postWithBytes(obj, bytes);
}

async function handleTaskMessage(message: any): Promise<void> {
  const {sab, filename, sourceMap} = message;

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
    const res = await fn(str, filename, sourceMap, currentWorkerOptions);
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
