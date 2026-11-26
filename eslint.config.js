import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist",
      "ios",
      "node_modules",
      ".vercel",
      "benchmarks/out",
      ".coach-preview.*",
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
    },
  },
  // Plain JavaScript that runs under Node: ops scripts, build tooling, config.
  {
    extends: [js.configs.recommended],
    files: ["**/*.{js,mjs}"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: globals.node,
    },
  },
  // Server and tooling TypeScript runs under Node, not the browser. The
  // benchmarks also import browser-side code from src/, so they keep both.
  {
    files: [
      "api/**/*.ts",
      "scripts/**/*.ts",
      "tools/**/*.ts",
      "*.config.ts",
    ],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["benchmarks/**/*.ts"],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  }
);
