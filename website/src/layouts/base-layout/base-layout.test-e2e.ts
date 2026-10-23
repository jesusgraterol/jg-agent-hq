import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { expectNoHorizontalOverflow, waitForPageAssets } from 'jg-playwright';

import { HOME_CONTENT, CONTROL_EXAMPLE } from '../../content/index.ts';
import { PAGE_RECORDS, SITE_CONFIG } from '../../site.config.ts';

for (const width of [320, 768, 1440]) {
  for (const colorScheme of ['light', 'dark'] as const) {
    test(`${width}px ${colorScheme}: responsive, accessible production pages`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
      const failures: string[] = [];
      page.on('pageerror', (error) => failures.push(error.stack || error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') failures.push(message.text());
      });
      page.on('response', (response) => {
        if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`);
      });
      for (const record of PAGE_RECORDS) {
        await page.goto(record.path);
        await waitForPageAssets(page);
        await expect(page).toHaveTitle(record.title);
        await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toHaveCount(1);
        if (record.id !== 'home') {
          const sizes = await page.getByRole('main').evaluate((element) => ({
            title: Number.parseFloat(getComputedStyle(element.querySelector('h1')!).fontSize),
            section: Number.parseFloat(getComputedStyle(element.querySelector('h2')!).fontSize),
          }));
          expect(sizes.title).toBeGreaterThan(sizes.section);
        }
        await expect(page.locator('html')).toHaveAttribute('data-resolved-theme', colorScheme);
        await expectNoHorizontalOverflow(page);
        const accessibility = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
          .analyze();
        expect(accessibility.violations).toStrictEqual([]);
        if (record.id === 'home' || record.id === 'examples')
          await page.screenshot({
            path: testInfo.outputPath(`${record.id}-${width}-${colorScheme}.png`),
            fullPage: true,
          });
      }
      expect(failures).toStrictEqual([]);
    });
  }
}

test('keyboard navigation, menu, theme persistence and reduced motion', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.goto('/');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();
  expect(
    await page
      .getByRole('link', { name: 'Skip to main content' })
      .evaluate((element) => getComputedStyle(element).outlineStyle),
  ).not.toBe('none');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();
  const menu = page.getByLabel('Navigation menu');
  await menu.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('navigation', { name: 'Mobile navigation' })).toBeVisible();
  await page.getByRole('button', { name: 'Use dark theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-resolved-theme', 'dark');
  await page.keyboard.press('Escape');
  await expect(menu).toBeFocused();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-resolved-theme', 'dark');
  expect(
    await page
      .getByRole('link', { name: 'Read the docs' })
      .evaluate((element) => Number.parseFloat(getComputedStyle(element).transitionDuration)),
  ).toBeLessThanOrEqual(0.001);
});

test('copies the exact package command and identifies external destinations', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(HOME_CONTENT.title);
  await page.getByRole('button', { name: 'Copy install command', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Copied install command', exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('[aria-live="polite"]').filter({ hasText: 'Copied to the clipboard.' }),
  ).toHaveText('Copied to the clipboard.');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    `npm install jg-agent-hq@${SITE_CONFIG.version}`,
  );
  await expect(page.getByRole('list', { name: 'Local setup' }).getByRole('article')).toHaveCount(3);
  await expect(
    page.getByRole('list', { name: 'Local setup' }).getByRole('heading', { level: 3 }),
  ).toHaveText(HOME_CONTENT.setup.map((step) => step.title));
  const source = page.getByRole('link', { name: /View source/ });
  await expect(source).toHaveAttribute('target', '_blank');
  await expect(source).toHaveAttribute('rel', /noreferrer/u);
  await expect(source).toContainText(/new tab/u);
  await page.goto('/docs/api/');
  const provider = page.getByRole('link', { name: /published provider control types/ });
  await expect(provider).toHaveAttribute('target', '_blank');
  await expect(provider).toContainText(/new tab/u);
});

test('blocked clipboard keeps usable failure guidance', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: () =>
          Promise.reject(new DOMException('Clipboard is blocked', 'NotAllowedError')),
      },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Copy install command', exact: true }).click();
  await expect(page.getByRole('button', { name: /Copy failed/u })).toBeVisible();
  await expect(page.locator('[data-copy-hint]:visible')).toContainText(/select|copy|clipboard/u);
  await expect(
    page.getByText(`npm install jg-agent-hq@${SITE_CONFIG.version}`, { exact: true }),
  ).toBeVisible();
});

test('documentation section navigation follows its rendered heading', async ({ page }) => {
  await page.goto('/docs/api/');
  const section = page
    .getByRole('navigation', { name: 'On this page' })
    .getByRole('link', { name: 'Lock lifecycle', exact: true });
  await section.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#lock-lifecycle$/u);
  await expect(page.getByRole('heading', { name: 'Lock lifecycle', exact: true })).toBeInViewport();
});

test('the API example copies the visible client code', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  const example = page.locator('section#session-code');
  await example.getByRole('button', { name: 'Copy code', exact: true }).click();
  await expect(example.getByRole('button', { name: 'Copied code', exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(CONTROL_EXAMPLE.call);
});

test('missing page has useful navigation and no indexing contract', async ({ page }) => {
  const response = await page.goto('/hq-missing-page-check/');
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Browse docs' })).toHaveAttribute('href', '/docs/');
  await expect(page.locator('link[rel="canonical"]')).toHaveCount(0);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/u);
});

test('the session example exposes its result and complete copyable source through keyboard controls', async ({
  page,
  context,
}) => {
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.stack || error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(message.text());
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.setViewportSize({ width: 320, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const demo = page.getByRole('tablist', { name: 'Session example view' });
  await demo.getByRole('tab', { name: 'Session flow' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(demo.getByRole('tab', { name: 'TypeScript' })).toBeFocused();
  await expect(demo.getByRole('tab', { name: 'TypeScript' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect(
    await demo
      .getByRole('tab', { name: 'TypeScript' })
      .evaluate((element) => getComputedStyle(element).outlineStyle),
  ).not.toBe('none');
  await page.getByRole('link', { name: 'See it in action' }).click();
  await expect(page).toHaveURL('/examples/');
  const example = page.getByRole('article', { name: CONTROL_EXAMPLE.title });
  const tabs = example.getByRole('tablist', { name: 'Native session control walkthrough' });
  await expect(tabs.getByRole('tab', { name: 'Result' })).toHaveAttribute('aria-selected', 'true');
  await tabs.getByRole('tab', { name: 'Result' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(tabs.getByRole('tab', { name: 'Run it' })).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(tabs.getByRole('tab', { name: 'Result' })).toHaveAttribute('aria-selected', 'true');
  await expect(example.getByRole('tabpanel', { name: 'Result' })).toContainText('acknowledged');
  await expect(example.getByRole('tabpanel', { name: 'Result' })).toContainText(
    'handle tool permissions separately',
  );
  await tabs.getByRole('tab', { name: 'Source' }).focus();
  await page.keyboard.press('Enter');
  const source = example.getByRole('tabpanel', { name: 'Source' });
  await expect(source).toContainText('export const controlSession');
  await source.getByRole('button', { name: 'Copy code', exact: true }).click();
  const markdown = await page.request.get('/examples/index.md');
  const body = await markdown.text();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain('export const controlSession');
  expect(body).toContain(copied);
  await expectNoHorizontalOverflow(page);
  expect(failures).toStrictEqual([]);
});

for (const walkthrough of [
  {
    id: 'review-handoff',
    title: 'Get another agent’s perspective',
    category: 'Agent review',
    link: 'Read the review walkthrough',
    helper: 'reviewHandoff',
    boundary: 'Feedback may still be queued or in flight.',
    callback: 'confirmRequest',
  },
  {
    id: 'revise-plan',
    title: 'Change the plan. Keep verified work.',
    category: 'Plan revision',
    link: 'Read the revision walkthrough',
    helper: 'revisePlan',
    boundary: 'Status markers alone never create verified completion.',
    callback: 'confirmCorrespondence',
  },
])
  for (const width of [320, 1440])
    for (const colorScheme of ['light', 'dark'] as const) {
      test(`${walkthrough.id}: ${width}px ${colorScheme} navigation, host decisions and complete source`, async ({
        page,
        context,
      }, testInfo) => {
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.stack || error.message));
        page.on('console', (message) => {
          if (message.type() === 'error') errors.push(message.text());
        });
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
        await page.setViewportSize({ width, height: 1000 });
        await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
        await page.goto('/');
        await page.getByRole('link', { name: walkthrough.link }).click();
        await expect(page).toHaveURL(`/examples/#${walkthrough.id}`);
        const example = page.getByRole('article', { name: walkthrough.title });
        const tabs = example.getByRole('tablist', { name: `${walkthrough.category} walkthrough` });
        for (const tab of await tabs.getByRole('tab').all()) {
          const box = await tab.boundingBox();
          expect(box!.x).toBeGreaterThanOrEqual(0);
          expect(box!.x + box!.width).toBeLessThanOrEqual(width);
        }
        await expect(example.getByRole('tabpanel', { name: 'Result' })).toContainText(
          walkthrough.boundary,
        );
        await expect(example.getByRole('figure')).toContainText('Illustrative');
        await example.screenshot({
          path: testInfo.outputPath(`${walkthrough.id}-${width}-${colorScheme}.png`),
        });
        await tabs.getByRole('tab', { name: 'Result' }).focus();
        await page.keyboard.press('ArrowRight');
        await expect(tabs.getByRole('tab', { name: 'Host inputs' })).toBeFocused();
        await expect(example.getByRole('tabpanel', { name: 'Host inputs' })).toContainText(
          walkthrough.callback,
        );
        await page.keyboard.press('ArrowRight');
        await expect(tabs.getByRole('tab', { name: 'Source' })).toBeFocused();
        const source = example.getByRole('tabpanel', { name: 'Source' });
        await expect(source).toContainText(`export const ${walkthrough.helper}`);
        const region = source.getByRole('region', {
          name: `${walkthrough.category} complete source`,
        });
        await region.focus();
        expect(await region.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe(
          'none',
        );
        await source.getByRole('button', { name: 'Copy code', exact: true }).click();
        const copied = await page.evaluate(() => navigator.clipboard.readText());
        expect(copied).toContain(`export const ${walkthrough.helper}`);
        expect(await (await page.request.get('/examples/index.md')).text()).toContain(copied);
        await expectNoHorizontalOverflow(page);
        const accessibility = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
          .analyze();
        expect(accessibility.violations).toStrictEqual([]);
        expect(errors).toStrictEqual([]);
      });
    }
