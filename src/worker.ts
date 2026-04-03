import {parentPort} from 'worker_threads';
import {pathToFileURL} from 'url';

let currentHandler: any = null;
let initPromise: Promise<any> | null = null;
let lastWorkerPath: string | null = null;

async function getHandler(processorPath: string): Promise<any> {
  const moduleSpecifier = processorPath.startsWith('file://')
    ? processorPath
    : pathToFileURL(processorPath).href;
  const mod = await import(moduleSpecifier);
  return mod.default || mod;
}

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
        parentPort!.postMessage({type: 'init_done', error: err.message});
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
        parentPort!.postMessage({type: 'init_done', error: err.message});
        throw err; // Ensure subsequent tasks fail if re-init fails
      }
    });
  } else {
    parentPort!.postMessage({type: 'init_done'});
  }
}

function processTaskResult(res: any, id: number, sourceMap: boolean): void {
  if (!res) {
    parentPort!.postMessage({id, result: '', imports: []});
    return;
  }

  const resultString = res.result || res.css || res.code || (typeof res === 'string' ? res : '');
  const obj: any = {
    id,
    result: resultString,
    imports: res.imports || []
  };

  if (res.extname) {
    obj.extname = res.extname;
  }

  if (sourceMap && res.map) {
    obj.sourcemap = typeof res.map === 'string' ? JSON.parse(res.map) : res.map;
  }

  parentPort!.postMessage(obj);
}

async function handleTaskMessage(message: any): Promise<void> {
  const {sab, filename, sourceMap, options, id} = message;

  if (initPromise) {
    try {
      await initPromise;
    } catch (err: any) {
      return parentPort!.postMessage({
        error: {
          message: `Worker initialization failed: ${err.message || err.toString()}`,
          filename
        },
        id
      });
    }
  }

  const view = new Uint8Array(sab);
  const decoder = new TextDecoder('utf-8');
  const str = decoder.decode(view);

  if (!currentHandler) {
    return parentPort!.postMessage({error: {message: 'No workerPath defined', filename}, id});
  }

  try {
    const fn = (typeof currentHandler.process === 'function') ? currentHandler.process : currentHandler;
    const res = await fn(str, filename, sourceMap, options.workerOptions || {});
    processTaskResult(res, id, sourceMap);
  } catch (err: any) {
    parentPort!.postMessage({
      error: {
        message: err.message || err.toString(),
        line: err.line,
        filename: err.filename || filename,
        extract: err.extract
      },
      id
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
          },
          id: message?.id
        });
      });
    }
  });
}
