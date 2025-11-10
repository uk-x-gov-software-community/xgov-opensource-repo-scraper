import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: ["node_modules/**", "public/**"],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "eqeqeq": ["warn", "always"],
      "no-console": "off",
      "prefer-const": "warn",
    },
  },
];
