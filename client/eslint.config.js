// Minimal ESLint setup. The goal here is one rule: catch Rules of Hooks
// violations BEFORE they hit a build that crashes the manga page at
// runtime (see the 1.12.0 → 1.12.1 hotfix history).
//
// Deliberately scoped — we don't want a code-quality crusade across a
// 3500-line component. If you want more rules later, add them; for now
// the contract is:
//   - rules-of-hooks: error    (the actual bug-catcher; build-breaking)
//   - exhaustive-deps: warn    (advisory; useful but the codebase has
//                               legitimate eslint-disable-next-line
//                               escape hatches in places, so don't make
//                               it block CI)
//
// Files outside client/src/ are not linted — the android/, electron/,
// and node_modules/ trees have their own rules / aren't ours to lint.

import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default [
  {
    files: ['src/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.browser,
        ...globals.serviceworker,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // Catches identifier shadowing — added after the 1.12.2 hotfix where
      // an inner `formatChapterLabel` inside a 3500-line component shadowed
      // a module-level helper of the same name, silently routing chapter-
      // row calls to the wrong function and producing "Vol. undefined Ch.
      // undefined" labels. The shadow was invisible to grep and to type-
      // less JS.
      //
      // `ignoreOnInitialization: true` excuses the common `arr.map(x => x)`
      // / `arr.filter(item => …)` patterns where the callback param happens
      // to share a name with an outer one — that's not the bug class we
      // care about.
      // `hoist: 'all'` flags function declarations hoisted into scope, so
      // an inner `function foo() {}` declared anywhere in the body is
      // caught against an outer `foo` (the exact 1.12.2 pattern).
      'no-shadow': ['error', { hoist: 'all', ignoreOnInitialization: true }],
    },
  },
];
