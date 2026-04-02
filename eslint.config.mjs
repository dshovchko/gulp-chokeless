import {lang, strict} from '@exadel/eslint-config-esl';

export default [
  {
    ignores: [
      // Common configuration
      'eslint.config.js',
      // Common directories
      'node_modules/**',
      // output directories
      'dist/**'
    ]
  },
  ...lang.ts,
  ...strict
];
