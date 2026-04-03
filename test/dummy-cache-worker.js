let cacheVal = 0;
exports.init = async (opts) => {
  if (opts.reset) cacheVal = 0;
};
exports.process = async () => {
  cacheVal++;
  return { result: cacheVal.toString() };
};
