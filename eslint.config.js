import tsPlugin from "@typescript-eslint/eslint-plugin";

export default [
  { ignores: ["dist/", "node_modules/", "src-tauri/"] },
  ...tsPlugin.configs["flat/recommended"],
  {
    files: ["src/**/*.ts"],
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
    },
  },
];
