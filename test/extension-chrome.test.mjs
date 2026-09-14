import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const enabled = process.env.SOCIAL_MEMORY_EXTENSION_CHROME_TEST === '1';
const extensionRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension');

test('real Chrome isolates extension installation state across two profiles', { skip: !enabled }, async (t) => {
  const { chromium } = await import('playwright-core');
  const root = await mkdtemp(join(tmpdir(), 'social-memory-extension-profiles-'));

  async function inspectProfile(name) {
    const context = await chromium.launchPersistentContext(join(root, name), {
      headless: false,
      ...(process.env.SOCIAL_MEMORY_CHROMIUM_EXECUTABLE
        ? { executablePath: process.env.SOCIAL_MEMORY_CHROMIUM_EXECUTABLE }
        : {}),
      args: [
        `--disable-extensions-except=${extensionRoot}`,
        `--load-extension=${extensionRoot}`,
      ],
    });
    t.after(() => context.close());
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 15_000 });
    const extensionId = new URL(worker.url()).hostname;
    const installationId = await worker.evaluate(async () => {
      const key = 'social-memory:installation-id';
      let value = (await chrome.storage.local.get(key))[key];
      if (!value) {
        value = crypto.randomUUID();
        await chrome.storage.local.set({ [key]: value });
      }
      return value;
    });
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.setViewportSize({ width: 340, height: 480 });
    const screenshot = join(root, `${name}-popup.png`);
    await popup.screenshot({ path: screenshot });
    return { extensionId, installationId, screenshot };
  }

  const first = await inspectProfile('profile-a');
  const second = await inspectProfile('profile-b');
  assert.equal(first.extensionId, second.extensionId);
  assert.notEqual(first.installationId, second.installationId);
  t.diagnostic(`popup screenshot: ${first.screenshot}`);
});
