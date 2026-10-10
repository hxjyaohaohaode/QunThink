import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testIgnore: ['**/q1/**', '**/q2/**', '**/site-basic-ai.spec.ts'], fullyParallel: false, workers: 1, retries: 0, timeout: 45000,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: 'http://127.0.0.1:3210', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile-reduced-motion', use: { ...devices['Pixel 7'], reducedMotion: 'reduce' } },
  ],
  webServer: [
    { command: 'node scripts/start-e2e-backend.mjs', url: 'http://127.0.0.1:3202/api/health', reuseExistingServer: false, timeout: 30000 },
    { command: 'npm run dev -- --host 127.0.0.1 --port 3210', url: 'http://127.0.0.1:3210', reuseExistingServer: false, timeout: 30000, env: { VITE_BACKEND_URL: 'http://127.0.0.1:3202', VITE_AUTH_MODE: 'session' } },
  ],
});
