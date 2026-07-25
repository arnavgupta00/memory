import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  snapshotDir: "./tests/snapshots",
  snapshotPathTemplate: "{snapshotDir}/{testFilePath}-snapshots/{arg}-{projectName}{ext}",
  use: { baseURL: "http://127.0.0.1:4173" },
  webServer: {
    command: "pnpm vite preview --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: true,
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-focus", use: { ...devices["Pixel 7"] } }
  ]
});
