import { readdirSync } from 'node:fs';
import path from 'node:path';
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

// Archived acceptance rounds keep source snapshots, generated bundles and
// per-run caches under test/. They are evidence, not maintained source. The
// maintained test trees stay linted.
const maintainedTestDirectories = new Set([
  'backend',
  'desktop',
  'fixtures',
  'frontend',
  'html-fixtures',
  'protocol',
  'results',
]);
const archivedTestDirectories = readdirSync(
  path.join(import.meta.dirname, 'test'),
  { withFileTypes: true },
)
  .filter(
    (entry) =>
      entry.isDirectory() &&
      !maintainedTestDirectories.has(entry.name),
  )
  .map((entry) => `test/${entry.name}/**`);

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'test/results/**',
      'references/**',
      ...archivedTestDirectories,
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['test/html-fixtures/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },
  {
    files: [
      'scripts/**/*.mjs',
      'test/**/*.mjs',
      'test/desktop/fixtures/**/*.cjs',
    ],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        // One explicit root prevents the parser from failing when archived
        // test evidence contains additional tsconfig files.
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
);
