// Single-threaded Gulp pipeline: Markdown -> HTML executed inline on the main thread.
import gulp from 'gulp';
import {Transform, Writable} from 'node:stream';
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

const pattern = process.env.BENCH_PATTERN || 'node_modules/**/*.md';

function inlineRender() {
  return new Transform({
    objectMode: true,
    transform(file, _enc, cb) {
      if (file.isNull() || !file.contents) return cb(null, file);
      try {
        const md = file.contents.toString('utf-8');
        const html = String(processor.processSync(md));
        file.contents = Buffer.from(html);
        file.extname = '.html';
      } catch {
        // Ignore parsing errors
      }
      cb(null, file);
    }
  });
}

function makeSink() {
  return new Writable({
    objectMode: true,
    write(_chunk, _enc, cb) { cb(); }
  });
}

export default function defaultTask() {
  return gulp.src(pattern, {allowEmpty: true})
    .pipe(inlineRender())
    .pipe(makeSink());
}
