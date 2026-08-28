import { test, expect } from '@playwright/test';

test('installed PWA metadata, shortcuts, and offline assets are complete', async ({ page, request }) => {
  await page.goto('/?action=subscribe');
  await expect(page.locator('#topic-input')).toBeFocused();

  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute('content', /viewport-fit=cover/);
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', '/apple-touch-icon.png');
  await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute('content', 'Pigeon');

  const manifestResponse = await request.get('/manifest.json');
  expect(manifestResponse.ok()).toBeTruthy();
  const manifest = await manifestResponse.json();
  expect(manifest.id).toBe('/');
  expect(manifest.display_override).toContain('standalone');
  expect(manifest.shortcuts.map(shortcut => shortcut.url)).toEqual(
    expect.arrayContaining(['/?action=subscribe', '/?action=compose']),
  );
  expect(manifest.icons.find(icon => icon.purpose === 'maskable').src).toBe('/icon-maskable-192.png');

  for (const asset of [
    '/index.html', '/apple-touch-icon.png', '/icon-maskable-192.png',
    '/icon-maskable-512.png', '/vendor/toastui-editor-all.min.js',
  ]) {
    expect((await request.get(asset)).ok()).toBeTruthy();
  }

  const stylesheet = await (await request.get('/style.css')).text();
  expect(stylesheet).toContain('env(safe-area-inset-top)');
  expect(stylesheet).not.toContain('fonts.googleapis.com');
});
