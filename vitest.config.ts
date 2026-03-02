import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
  },
  resolve: {
    alias: {
      vscode: resolve(__dirname, "src/__mocks__/vscode.ts"),
    },
  },
});
