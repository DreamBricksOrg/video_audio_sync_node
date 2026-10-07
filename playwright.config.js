// Browser tests (npm run test:e2e). Each spec starts the real server.js with
// temporary data via tests/helpers/server.js — never the developer's .env.
const { defineConfig, devices } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "e2e",
  timeout: 30000,
  expect: { timeout: 5000 },
  fullyParallel: false,
  workers: 2,
  reporter: process.env.CI ? "github" : "list",
  use: {
    ...devices["Desktop Chrome"],
    headless: true,
    trace: "retain-on-failure",
  },
});
