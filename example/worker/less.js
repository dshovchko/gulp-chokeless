import less from 'less';
import lightningProcessor from './lightningcss.js';
import bannerProcessor from './banner.js';

export async function init() {
  // Something you want to do once when the worker starts up
  return 'LESS Worker Ready';
}

export async function process(contentStr, filename, sourceMapFlag, workerOptions = {}) {
  // 1. LESS Compilation
  const lessOpts = Object.assign({}, workerOptions.less || {}, {
    filename,
    sourceMap: sourceMapFlag
  });

  const lessResult = await less.render(contentStr, lessOpts);

  let finalCss = lessResult.css;
  let finalMap = lessResult.map;

  // 2. Post-processor: Banner Add
  const bannerOpts = Object.assign({}, workerOptions.banner || {}, { filename });
  let output = await bannerProcessor(finalCss, finalMap, bannerOpts);

  if (typeof output === 'string') {
    finalCss = output;
  } else if (output) {
    finalCss = output.css || finalCss;
    finalMap = output.map || finalMap;
  }

  // 3. Post-processor: LightningCSS
  const lightningOpts = Object.assign({}, workerOptions.lightningcss || {}, { filename });
  output = await lightningProcessor(finalCss, finalMap, lightningOpts);

  if (typeof output === 'string') {
    finalCss = output;
  } else if (output) {
    finalCss = output.css || finalCss;
    finalMap = output.map || finalMap;
  }

  // 4. Return formatted response to standard generic gulp-chokeless
  return {
    result: finalCss,
    map: finalMap,
    imports: lessResult.imports,
    extname: '.css'
  };
}
