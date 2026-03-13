import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir:  "./tests",
  timeout:  90_000,
  retries:  1,

  use: {
    baseURL:   "http://localhost:3001",
    headless:  true,
    // Keep viewport large enough for the 3D canvas to fully render
    viewport:  { width: 1280, height: 800 },
  },

  webServer: {
    command:              "npm run dev -- --port 3001",
    url:                  "http://localhost:3001",
    // Reuse the already-running dev server when running tests locally
    reuseExistingServer:  !process.env.CI,
    timeout:              60_000,
  },
});
