/**
 * ESLint flat config.
 *
 * SCOPE: correctness, not style. Prettier owns formatting (see `.prettierrc.json`)
 * and `eslint-config-prettier` is applied LAST here to switch off every rule the
 * two could argue about — a file that satisfies one tool must never fail the
 * other, or `lint:fix` and `format` start undoing each other.
 *
 * TypeScript is already strict — `noUncheckedIndexedAccess`,
 * `exactOptionalPropertyTypes` — and stays the primary gate. These rules cover
 * what `tsc` cannot see, and several exist because of a specific bug this
 * codebase actually shipped; those carry the story, because a rule whose reason
 * is recorded survives the next person who finds it inconvenient.
 */
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    // Build output, deps, and the generated elevation blob.
    ignores: ['dist/**', 'node_modules/**', 'public/**', 'coverage/**'],
  },

  js.configs.recommended,
  // strictTypeChecked over recommended: the type-aware rules are the ones with
  // something to say about a codebase that already passes strict tsc. Individual
  // rules are dialled back below where they fight this project rather than help.
  ...tseslint.configs.strictTypeChecked,

  {
    // Plain JS: this config and the elevation fetch script. Node scripts, so
    // they get Node globals — without this, `console` and `Buffer` read as
    // undefined and bury the real findings in noise.
    //
    // `disableTypeChecked` is required, not optional: strictTypeChecked enables
    // rules that need a TypeScript program, and applying those to a .js file
    // outside the project is a hard ESLint crash rather than a lint error.
    files: ['**/*.{js,mjs,cjs}'],
    ...tseslint.configs.disableTypeChecked,
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

      /* ---- Additional correctness rules ---- */

      /**
       * The read-path rule in CLAUDE.md, enforced. SQL returns null; the schemas
       * are `.optional()` and never `.nullable()`. `??` respects that
       * distinction and `||` does not — `value || fallback` also replaces 0 and
       * '', so a significance of 0 or an empty baseline silently becomes the
       * fallback and the model reads a number nobody published.
       */
      '@typescript-eslint/prefer-nullish-coalescing': [
        'error',
        { ignorePrimitives: { string: true } },
      ],

      /**
       * A number in this codebase is usually a year, an effect or a score, and
       * `${score}` on an accidental object yields "[object Object]" in a prompt
       * or a log — silently, and where it is hardest to notice.
       */
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],

      /** Await a non-promise, or forget to await one: both are real bugs here. */
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',

      '@typescript-eslint/no-misused-spread': 'error',
      'no-promise-executor-return': 'error',
      'no-unmodified-loop-condition': 'error',

      /* ---- Rules dialled back, with the reason ---- */

      /**
       * WARN, not error. `!` is the documented escape hatch for
       * `noUncheckedIndexedAccess`, and `rows[0]!` after a length check appears
       * ~50 times in working, tested code. Rewriting all of those mechanically
       * would risk behaviour for no defect found. Warning nudges new code
       * without a churn commit nobody asked for.
       */
      '@typescript-eslint/no-non-null-assertion': 'warn',

      /**
       * Off: the in-memory port implementations must be `async` to satisfy the
       * same interface as their Postgres counterparts, and several Fastify
       * handlers are async by the framework's contract. Neither awaits anything,
       * and neither is a mistake.
       */
      '@typescript-eslint/require-await': 'off',

      /**
       * Off at the base, ON for `src/` and `shared/` below. In `server/` the
       * types are unchecked assertions about external data — see the block that
       * re-enables it for the reasoning.
       */
      '@typescript-eslint/no-unnecessary-condition': 'off',

      /**
       * Off for the same reason. `Number(row.effect)` looks redundant because
       * `sql<Row>` declares the column a number, but node-postgres returns
       * NUMERIC as a STRING — the conversion is what makes the declared type
       * true, and removing it would put a string where the maths expects a
       * number and produce silent concatenation.
       */
      '@typescript-eslint/no-unnecessary-type-conversion': 'off',

      /**
       * The `void` shorthand is a deliberate marker here — `() => void onCopy()`
       * says "fire and forget, errors handled inside" — so flagging it would
       * punish the pattern `no-misused-promises` asked for.
       */
      '@typescript-eslint/no-confusing-void-expression': [
        'error',
        { ignoreArrowShorthand: true, ignoreVoidOperator: true },
      ],

      /**
       * Off: this codebase deliberately uses `interface Foo { ... }` and type
       * aliases interchangeably by meaning — shapes as interfaces, unions and
       * mapped types as aliases — and the rule cannot tell the difference.
       */
      '@typescript-eslint/consistent-type-definitions': 'off',

      /**
       * Off: the zod-derived types are structurally huge, and the rule fires on
       * every `satisfies`-style narrowing of a parsed row where the assertion is
       * the point.
       */
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',

      /**
       * Warn, not error. Enum-like string unions read fine without exhaustive
       * switches when the default is a documented fallback, which is the pattern
       * throughout the read paths.
       */
      '@typescript-eslint/switch-exhaustiveness-check': 'warn',
    },
  },

  {
    /**
     * `no-unnecessary-condition` only where the types are EARNED.
     *
     * In `src/` and `shared/` a type comes from a zod parse or a local
     * construction, so a guard the type says is impossible really is dead code.
     *
     * In `server/` it is routinely wrong, and dangerously so. `sql<Row>` is an
     * unchecked assertion about what Postgres will return; `await res.json() as
     * T` is an unchecked assertion about a remote API; a JSONB column is
     * whatever was written to it. The rule reads those as facts and calls the
     * runtime guard redundant — `if (!body.data)` against an embedding API,
     * `tp?.recovery !== null` against a JSONB blob. Deleting those to satisfy
     * the linter would remove the checks that catch exactly the case the type
     * cannot promise.
     */
    files: ['src/**/*.{ts,tsx}', 'shared/**/*.ts'],
    ignores: ['**/*.test.ts', '**/*.test.tsx'],
    /**
     * WARN, not error, even here. Two idioms this codebase depends on defeat
     * the rule's analysis, and both are correct code:
     *
     *   - `let cancelled = false` set true in a React effect's cleanup. Control
     *     flow analysis cannot see the later mutation, so it calls the guard
     *     always-truthy — and that guard is what stops a resolved fetch writing
     *     state into an unmounted component.
     *   - `navigator.share?.(…)`. lib.dom declares `share` as always present;
     *     it is absent in most desktop browsers. The optional call is real
     *     feature detection.
     *
     * As an error it would pressure someone into deleting working safety
     * checks to make the build pass. As a warning it still surfaces genuinely
     * dead conditions for a human to judge.
     */
    rules: { '@typescript-eslint/no-unnecessary-condition': 'warn' },
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
    rules: {
      '@typescript-eslint/consistent-type-assertions': 'off',
      /**
       * three.js hands back methods intended to be called detached
       * (`renderer.setSize`, disposal callbacks), and none of them are declared
       * `this: void`. The rule cannot distinguish that from a genuine lost
       * `this`, and the library's typings are not ours to change.
       */
      '@typescript-eslint/unbound-method': 'off',
    },
  },

  {
    files: ['**/*.test.ts', '**/*.test.tsx'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // Tests construct deliberately malformed inputs to prove the guards work,
      // and assert on values the types say cannot happen — which is the point.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/consistent-type-assertions': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },

  // LAST, deliberately: turns off every rule that could conflict with Prettier.
  // Anything above this line that is purely stylistic is disabled by it, which
  // is what keeps `lint:fix` and `format` from fighting each other.
  prettier,
);
