// Same pattern as dummy-stray-message-worker.js, but the stray message reuses
// `result` as a property name (a plain number, not shaped like a real task
// response) -- regression test for the tightened isTaskResponse() shape check
// (data.result instanceof ArrayBuffer), not just key presence.
const { parentPort } = require('worker_threads');

exports.init = async () => 'Init OK';
exports.process = async (contentStr) => {
  if (parentPort) parentPort.postMessage({ type: 'progress', result: 50 });
  await new Promise(r => setTimeout(r, 5));
  return { result: contentStr + '-DONE' };
};
