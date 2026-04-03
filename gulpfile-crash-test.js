const path = require('path');
const createGulpWorkerPool = require('./dist/index.js').default || require('./dist/index.js');
const pool = createGulpWorkerPool({ workerPath: path.resolve(__dirname, './test/dummy-fatal-crash-worker.js'), concurrency: 1 });

const stream1 = pool();
stream1.on('error', (e) => console.log('STREAM 1 Error expected:', e.message));
stream1.write({ isNull: ()=>false, isStream: ()=>false, path: 'crash.less', relative: 'crash.less', contents: Buffer.from('')});

setTimeout(() => {
   const stream2 = pool();
   stream2.on('data', (d) => console.log('STREAM 2 SUCCESS:', d.contents.toString()));
   stream2.write({ isNull: ()=>false, isStream: ()=>false, path: 'ok.less', relative: 'ok.less', contents: Buffer.from('hello')});
}, 500);
