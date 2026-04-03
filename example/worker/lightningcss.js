import {transform} from 'lightningcss';

export default function(cssText, sourceMapText, options = {}) {
  if (options.bypass) {
    return { css: cssText, map: sourceMapText };
  }

  // 1. Transform raw LESS -> CSS
  const result = transform({
    filename: options.filename || 'style.css',
    code: Buffer.from(cssText),
    minify: options.minify,
    sourceMap: options.sourceMap,
    targets: options.targets, // Passed pre-evaluated targets from the Main Thread!
    errorRecovery: true,
    inputSourceMap: sourceMapText ? sourceMapText : undefined
  });

  let finalCssStr = result.code.toString('utf8');
  let finalMapStr = result.map ? result.map.toString('utf8') : sourceMapText;

  return {
    css: finalCssStr,
    map: finalMapStr
  };
};
