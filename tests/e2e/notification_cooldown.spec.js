import { test, expect } from '@playwright/test';

// Copy-without-open (#50): the service worker's Copy shade action opens
// /?topic=...&copy=1#c=<body>. On load the page writes the fragment to the
// clipboard, toasts, and strips the secret from the URL bar. The SW-side
// audible budget / collapse tags / Copy-action logic is unit-tested in
// tests/sw_notification.test.js (headless Chromium has no push service, so the
// actual showNotification path can't be driven end-to-end here).

test('copy-consume writes the fragment to the clipboard and strips it', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

  await page.goto('/?topic=alerts&copy=1#c=OTP%20123456');

  await expect(page.locator('.toast')).toContainText('Copied');

  const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboardText).toBe('OTP 123456');

  // The secret must not linger in the URL bar; only the #c= fragment is
  // dropped (the query is left alone).
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('');
});

test('copy-consume falls back to a selectable dialog when the clipboard is denied', async ({ page }) => {
  await page.addInitScript(() => {
    const reject = async () => { throw new DOMException('Not allowed', 'NotAllowedError'); };
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: reject },
    });
  });

  await page.goto('/?copy=1#c=disk2%20backup%20failed');

  const dialog = page.locator('#copy-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.locator('#copy-dialog-text')).toHaveValue('disk2 backup failed');

  // No toast, no clipboard write — the dialog is the honest fallback (never prompt()).
  await expect(page.locator('.toast')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('');
});
