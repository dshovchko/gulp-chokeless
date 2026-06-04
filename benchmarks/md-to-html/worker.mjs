// gulp-chokeless worker for md-to-html scenario.
// Parses Markdown into HTML via remark/rehype with a custom AST manipulator.

import {unified} from 'unified';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import {visit} from 'unist-util-visit';

function myAstManipulator() {
  return (tree) => {
    visit(tree, 'text', (node) => {
      if (node.value) node.value = node.value.toUpperCase();
    });

    visit(tree, 'heading', (node, index, parent) => {
      if (parent && typeof index === 'number') {
        const injectedAd = {
          type: 'paragraph',
          children: [
            {type: 'text', value: '🚀 Processed lightning fast by '},
            {type: 'strong', children: [{type: 'text', value: 'gulp-chokeless'}]},
            {type: 'text', value: ' '},
            {type: 'image', url: 'https://example.com/logo.png', alt: 'gulp-chokeless logo image'}
          ]
        };
        parent.children.splice(index + 1, 0, injectedAd);
        return index + 2;
      }
    });
  };
}

const processor = unified()
  .use(remarkParse)
  .use(myAstManipulator)
  .use(remarkRehype)
  .use(rehypeStringify);

export async function init() {
  return 'md-to-html worker ready';
}

export async function process(contentStr /* , filename, sourceMapFlag, workerOptions */) {
  let html = '';
  try {
    html = String(processor.processSync(contentStr));
  } catch {
    // Ignore parsing errors from broken or malformed files
  }
  return {result: html, extname: '.html'};
}
