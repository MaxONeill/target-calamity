/**
 * ESLint flat config.
 *
 * SCOPE: this linter is for what `tsc` cannot see. TypeScript is already strict
 * here — `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` — and it stays
 * the gate for correctness. Duplicating type rules would add noise without
 * catching anything new, so the rules below are the ones that encode this
 * codebase's actual, learned hazards.
 *
 * Formatting is deliberately absent. No stylistic rules, no Prettier: churning
 * every file to settle quote style would bury real history in whitespace diffs,
 * and nothing here has been a source of bugs.
 */
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    // Build output, deps, and the generated elevation blob.
    ignores: ['dist/**', 'node_modules/**', 'public/**', 'coverage/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    // Plain JS: build config and the elevation fetch script. Node scripts, so
    // they get Node globals — without this, `console` and `Buffer` read as
    // undefined and bury the real findings in noise.
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: { globals: { ...globals.node } },
  },

  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        projectService: {
          // Config files live outside tsconfig's `include` but still deserve
          // linting; without this the parser errors on them instead.
          allowDefaultProject: ['*.js', '*.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      // TypeScript resolves identifiers itself and does it better; the base rule
      // only produces false positives on type-only and ambient names.
      'no-undef': 'off',

      /* ---- Rules that exist because of real incidents in this repo ---- */

      /**
       * `exactOptionalPropertyTypes` makes zod's `.optional()` (`T | undefined`)
       * nominally distinct from `?: T`, and the tempting fix is a cast — which
       * silently drops the field instead of copying it. `toClockFactor` lost
       * `closesWindow` and `quantityThreshold` exactly this way, and the Clock
       * quietly stopped anchoring. Rebuild the object explicitly.
       */
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { assertionStyle: 'as', objectLiteralTypeAssertions: 'never' },
      ],

      /**
       * A floating promise in an ingestion script means the process can exit
       * before a write lands, which looks exactly like "the model found
       * nothing" — the most expensive class of silent failure here, because the
       * retrieval was already paid for.
       */
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      /** `await` inside a retrieval loop is load-bearing for rate limits. */
      'require-atomic-updates': 'error',

      /* ---- General hygiene ---- */

      '@typescript-eslint/no-unused-vars': [
        'error',
        // Leading underscore is the established opt-out in this codebase
        // (`_req`, `_reply` in Fastify handlers).
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // `any` defeats the strict config the rest of the project leans on.
      '@typescript-eslint/no-explicit-any': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'off', // ingestion scripts report progress on stdout by design
    },
  },

  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      /**
       * Warn, not error. Several hooks here depend on a deliberately PARTIAL
       * dependency list — `useCountdown` keys on `model.targetYear` rather than
       * `model`, so the interval is not torn down and rearmed every render.
       * Those are documented decisions; the rule should flag them for a human,
       * not fail the build.
       */
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  {
    // The scene layer is imperative three.js by design: it mutates buffers in
    // place and reads back from GPU objects, where the strictest assertion rules
    // fight the library's own typings rather than catching anything.
    files: ['src/scene/**/*.ts', 'src/globe/**/*.ts'],
    rules: { '@typescript-eslint/consistent-type-assertions': 'off' },
  },

  {
    files: ['**/*.test.ts', '**/*.test.tsx'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // Tests construct deliberately malformed inputs to prove the guards work.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/consistent-type-assertions': 'off',
    },
  },
);
