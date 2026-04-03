exports.init = async (options) => 'Init OK';
exports.process = async (contentStr, filename, sourceMapFlag, workerOptions) => {
  await new Promise(r => setTimeout(r, 10));
  return {
    result: contentStr + (workerOptions.suffix || '-PROCESSED'),
    extname: '.css'
  };
};
