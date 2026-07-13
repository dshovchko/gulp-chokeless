// Returns a raw SharedArrayBuffer directly as `result` (not wrapped in a
// Uint8Array view), to verify toTransferableBytes() copies it into a private
// ArrayBuffer instead of falling through to String(value) and producing
// "[object SharedArrayBuffer]" (regression test for the raw-SAB review fix).
exports.init = async () => 'Init OK';
exports.process = async () => {
  const sab = new SharedArrayBuffer(4);
  new Uint8Array(sab).set([0x41, 0xFF, 0x00, 0x42]);
  return {
    result: sab,
    extname: '.bin'
  };
};
