exports.process = async (str, filename, sourceMap, workerOptions) => {
  if (filename && filename.includes('crash')) {
    process.exit(1);
  }
  return { result: str + '-OK', extname: '.css' };
};
