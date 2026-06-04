// gulp-chokeless worker for validate-json scenario.
// Validates each JSON document against a JSON schema using AJV.

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

export async function init() {
  return 'validate-json worker ready';
}

export async function process(contentStr /* , filename, sourceMapFlag, workerOptions */) {
  try {
    const json = JSON.parse(contentStr);
    validate(json);
  } catch {
    // Ignore malformed JSON files found in random node_modules sub-folders
  }
  // Pass through original content unchanged
  return {result: contentStr};
}
