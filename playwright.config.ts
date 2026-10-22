import {defineConfig} from '@playwright/test';
export default defineConfig({
  testDir: './e2e', timeout: 30000, fullyParallel: false, workers: 1,
  use: {baseURL: 'http://127.0.0.1:5197', viewport: {width: 1440, height: 1200}, trace: 'retain-on-failure'},
  webServer: {command: 'npm run dev -- --port 5197 --strictPort', url: 'http://127.0.0.1:5197', reuseExistingServer: true},
});
