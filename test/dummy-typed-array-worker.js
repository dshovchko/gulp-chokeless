// Returns a non-Uint8Array ArrayBufferView (Uint16Array) as the result, to
// verify toTransferableBytes() normalizes any typed-array view to raw bytes
// instead of falling through to String(value) and UTF-8-encoding it
// (regression test for the ArrayBufferView-normalization review fix).
exports.init = async () => 'Init OK';
exports.process = async () => {
  const ta = new Uint16Array([0x0041, 0x00FF, 0x1234]);
  return {
    result: ta,
    extname: '.bin'
  };
};
