import { defineConfig, devices } from '@playwright/test';

// Separate process, ports and synthetic data prevent this additional suite from
// spending the pre-existing core suite's real shared-IP session quota. Production
// limits, core assertions and zero retries are deliberately unchanged.
export default defineConfig({
  testDir: './e2e', testMatch: 'site-basic-ai.spec.ts',
  fullyParallel: false, workers: 1, retries: 0, timeout: 45000,
  outputDir: './test-results/site-basic',
  reporter: [['list'], ['html', { outputFolder: 'playwright-report/site-basic', open: 'never' }], ['json', { outputFile: 'test-results/site-basic/results.json' }]],
  use: { baseURL: 'http://127.0.0.1:3220', trace: 'on', video: 'on', screenshot: 'on' },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile-reduced-motion', use: { ...devices['Pixel 7'], reducedMotion: 'reduce' } },
  ],
  webServer: [
    { command: 'node scripts/start-site-ai-backend.mjs', url: 'http://127.0.0.1:3222/api/health', reuseExistingServer: false, timeout: 30000 },
    { command: 'npm run dev -- --host 127.0.0.1 --port 3220 --strictPort', url: 'http://127.0.0.1:3220', reuseExistingServer: false, timeout: 30000, env: { VITE_BACKEND_URL: 'http://127.0.0.1:3222', VITE_AUTH_MODE: 'session' } },
  ],
});
