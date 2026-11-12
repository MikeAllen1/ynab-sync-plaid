// Browser regression tests for the dashboard and setup pages (npm run test:browser).
// The pages are served from src/ui with every endpoint answered from fixtures, so no
// Plaid, YNAB or Cloudflare account is needed. First time: npx playwright install chromium
import { defineConfig } from "@playwright/test";

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;

export default defineConfig({
  testDir: "test/browser",
  testMatch: "*.spec.ts",
  fullyParallel: true,
  reporter: process.env.CI ? "github" : "list",
  use: { launchOptions: { executablePath }, colorScheme: "light" },
  projects: [
    { name: "desktop", use: { viewport: { width: 1280, height: 900 } } },
    { name: "phone", use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
  ],
});
