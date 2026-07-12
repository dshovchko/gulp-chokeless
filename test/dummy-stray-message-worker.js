// Simulates user process() code (or a library it calls) reaching into
// worker_threads directly and posting its OWN message on the same parentPort
// gulp-chokeless uses internally -- regression test for the message-shape
// guard (isTaskResponse) added in review response.
const { parentPort } = require('worker_threads');

exports.init = async () => 'Init OK';
exports.process = async (contentStr) => {
  // A stray message shaped nothing like a task response (no `result`/`error`).
  if (parentPort) parentPort.postMessage({ type: 'progress', percent: 50 });
  await new Promise(r => setTimeout(r, 5));
  return { result: contentStr + '-DONE' };
};
