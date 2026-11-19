import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
// Use an already-installed Windows browser; never download a browser implicitly.
const channel = process.env.FLSD_E2E_CHANNEL ?? (existsSync('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe') ? 'msedge' : undefined);
const port=process.env.FLSD_E2E_PORT??'3000';
export default defineConfig({
 testDir: './tests/e2e', workers: 1, fullyParallel: false,
 use: { baseURL: `http://127.0.0.1:${port}`, channel, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
 webServer: { command: `npm.cmd run dev -- --port ${port}`, url: `http://127.0.0.1:${port}`, reuseExistingServer: !process.env.CI, timeout: 120_000 },
});
