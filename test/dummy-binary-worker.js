// Returns a binary Buffer result (with bytes that are not valid UTF-8), to
// verify binary results survive the worker->main transfer without being
// string-coerced/corrupted (regression test for zero-copy result handling).
exports.init = async () => 'Init OK';
exports.process = async () => {
  // 0xFF/0xFE are invalid standalone UTF-8 bytes; if the result were ever
  // stringified (e.g. via TextEncoder.encode(buffer)) these would be mangled
  // into the U+FFFD replacement character instead of round-tripping exactly.
  const bytes = Buffer.from([0x00, 0xFF, 0x10, 0xFE, 0x7F, 0x80, 0x01]);
  return {
    result: bytes,
    extname: '.bin'
  };
};
