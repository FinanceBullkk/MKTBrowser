// ESLint flat config for the MKT Browser workspace.
//
// Before this existed, `yarn lint` ran `tsc --noEmit` with three extra flags in each workspace.
// That is a type check, not a linter: it cannot see an unawaited promise, a lost `catch`, a
// `case` that falls into the next one by accident, or a control-flow constant. The half of the
// product carrying the largest files was the unlinted half.
//
// Deliberately started at the recommended sets without type-aware rules. Type-aware linting needs
// a program per workspace and multiplies lint time; it is worth adding once the recommended set is
// held clean, not as the opening move.
import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // Build output and vendored trees. `.yarn` holds Yarn's own releases and plugins. CI also
    // checks out the private MKTTool repository as `mkttool/` for cross-repository contracts; it has
    // a separate dependency graph and must not be linted by this workspace config.
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/out/**",
      "**/release/**",
      "mkttool/**",
      ".yarn/**",
      "**/*.d.ts",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    // Electron main, packaging scripts and installer helpers all run under Node.
    files: ["**/*.{ts,tsx,js,cjs,mjs}"],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // The renderer talks to the main process over IPC, which is promise-based throughout. A
      // dropped `await` there surfaces as a silently missing profile action, not as an error.
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },

  {
    // Renderer code additionally sees the DOM.
    files: ["apps/*/src/renderer/**/*.{ts,tsx}", "apps/*/src/**/*.tsx"],
    languageOptions: {
      globals: { ...globals.browser },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      // Only the two correctness rules, not the plugin's full recommended set. The rest of that
      // set is React-Compiler-era performance advice (`set-state-in-effect` and friends) that
      // would require reworking renderer components; that is a deliberate refactor, not something
      // to absorb while first turning a linter on. `exhaustive-deps` in particular has to be here:
      // the renderer already carries `eslint-disable react-hooks/exhaustive-deps` comments written
      // against a linter that was never actually wired up.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },

  {
    // The companion content script is injected into the page, not run by Node. It legitimately
    // sees only browser globals, and it must stay plain browser-target JS.
    files: ["apps/*/resources/companion/**/*.js"],
    languageOptions: {
      sourceType: "script",
      globals: { ...globals.browser },
    },
  },

  {
    // CommonJS build and test helpers under scripts/.
    files: ["**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { ...globals.node, ...globals.commonjs },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
);
