export default function(cssText, sourceMapText, options = {}) {
  if (options.text) {
    return {
      css: options.text + '\n' + cssText,
      map: sourceMapText
    };
  }

  return {
    css: cssText,
    map: sourceMapText
  };
}
