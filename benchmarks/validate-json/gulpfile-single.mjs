// Single-threaded Gulp pipeline: AJV validation executed inline on the main thread.
import gulp from 'gulp';
import {Transform, Writable} from 'node:stream';
import {readFileSync} from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const schemaData = readFileSync(new URL('./schema.json', import.meta.url), 'utf-8');
const schema = JSON.parse(schemaData);

const ajv = new Ajv({strict: false, allErrors: true});
addFormats(ajv);

const dummySchemas = [
  'https://json.schemastore.org/eslintrc.json',
  'https://json.schemastore.org/stylelintrc.json',
  'https://json.schemastore.org/ava.json',
  'https://json.schemastore.org/semantic-release.json',
  'https://json.schemastore.org/jscpd.json',
  'https://json.schemastore.org/nodemon.json',
  'https://www.schemastore.org/prettierrc.json'
];
for (const id of dummySchemas) {
  ajv.addSchema({$id: id});
}

const validate = ajv.compile(schema);

const pattern = process.env.BENCH_PATTERN || 'node_modules/**/package.json';

function inlineValidate() {
  return new Transform({
    objectMode: true,
    transform(file, _enc, cb) {
      if (file.isNull() || !file.contents) return cb(null, file);
      try {
        const json = JSON.parse(file.contents.toString('utf-8'));
        validate(json);
      } catch {
        // Ignore parse/validation errors
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
    .pipe(inlineValidate())
    .pipe(makeSink());
}
