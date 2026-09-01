import js from '@eslint/js';
import globals from 'globals';
import parser from '@typescript-eslint/parser';
import typescript from '@typescript-eslint/eslint-plugin';

/**
 * ESLint 9 flat config.
 *
 * `npm run lint` has been in package.json since the first commit and has never
 * run: ESLint 9 wants a flat config and there was not one, so it exited before
 * reading a line of source. This is that file.
 *
 * The rules are deliberately few. TypeScript already catches most of what a
 * linter would, the tests catch the rest, and a wall of stylistic complaints is
 * how a lint step gets ignored. What is here is the set that has actually
 * caught something in this codebase: promises dropped on the floor — which is
 * most of the loading path now — and dead code left behind by a refactor.
 */
export default [
  {
    ignores: ['dist/**', 'node_modules/**', '*.config.js'],
  },
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser,
      parserOptions: {
        // Type-aware linting. Slower, and the only way to know that a call
        // returns a promise nobody is waiting on.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        sourceType: 'module',
      },
      globals: {
        ...globals.browser,
        ...globals.worker,
      },
    },
    plugins: { '@typescript-eslint': typescript },
    rules: {
      // The base rule does not understand types, overloads or declaration
      // merging; the TypeScript one does.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // `no-undef` duplicates the compiler and gets the DOM wrong.
      'no-undef': 'off',

      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      // Off, after trying it. Every site it flagged was a guard that is right
      // and a type that is optimistic: `window.AudioContext` is declared as
      // always present and is not, three declares `getAttribute` as always
      // returning an attribute and it does not, and an array index is declared
      // as always in range because `noUncheckedIndexedAccess` is off. A rule
      // that asks for correct defensive code to be deleted is worse than no
      // rule.
      '@typescript-eslint/no-unnecessary-condition': 'off',

      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  {
    // Scripts run in node, not a browser: they need its globals and print to
    // its console on purpose.
    files: ['scripts/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
  },
];
