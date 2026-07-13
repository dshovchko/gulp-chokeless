// Returns a Uint8Array view that spans an ENTIRE SharedArrayBuffer, to verify
// toTransferableBytes() always copies SharedArrayBuffer-backed results into a
// private, transferable ArrayBuffer instead of returning the shared view
// as-is (regression test for the SharedArrayBuffer-copy review fix).
exports.init = async () => 'Init OK';
exports.process = async () => {
  const sab = new SharedArrayBuffer(5);
  const view = new Uint8Array(sab);
  view.set([0x00, 0xFF, 0x10, 0xFE, 0x01]);
  return {
    result: view,
    extname: '.bin'
  };
};
