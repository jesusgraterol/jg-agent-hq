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
        await expect(
          page.locator('[data-copy-button]:not([data-copy-display="icon"])'),
        ).toHaveCount(0);
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
      .getByRole('link', { name: HOME_CONTENT.startLink.label })
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
  const source = page.getByRole('banner').getByRole('link', { name: /Source repository/ });
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

test('the session example copies its visible caller code', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/examples/');
  const example = page.getByRole('article', { name: CONTROL_EXAMPLE.title });
  await example.getByRole('tab', { name: 'Run it' }).click();
  const panel = example.getByRole('tabpanel', { name: 'Run it' });
  await panel.getByRole('button', { name: 'Copy code', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Copied code', exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(CONTROL_EXAMPLE.call);
});

test('the homepage shows how HQ fits and previews every capability', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('figure', { name: HOME_CONTENT.map.caption })).toContainText(
    HOME_CONTENT.map.hq.title,
  );
  await page.getByRole('link', { name: 'See what it does' }).click();
  await expect(page).toHaveURL(/#capabilities$/u);
  for (const capability of HOME_CONTENT.capabilities) {
    const article = page.getByRole('article', { name: capability.title });
    await expect(article.getByRole('figure')).toContainText('Illustrative');
    await expect(
      article.getByRole('list', { name: `${capability.title}: commands` }).getByRole('listitem'),
    ).toHaveText([...capability.commands]);
    if (capability.link)
      await expect(article.getByRole('link', { name: capability.link.label })).toHaveAttribute(
        'href',
        capability.link.href,
      );
  }
  const usage = page.getByRole('article', { name: 'See output, history and usage' });
  await expect(usage.getByRole('group', { name: 'Claude Code usage' })).toContainText('Opus');
  await expect(usage.getByRole('group', { name: 'Codex usage' })).toContainText('Credit balance');
  await expect(usage.getByRole('group', { name: 'Codex usage' })).toContainText('Earned resets');
  const collaboration = page.getByRole('article', { name: 'Let agents work together' });
  await expect(collaboration).toContainText('granted skill jg-review-session');
  // plan approval checks plan.md alone; the uncovered criterion is refused at sequence approval
  const gates = page
    .getByRole('article', { name: 'Change the plan, keep the work' })
    .getByRole('list', { name: 'Approvals checked by jg-plans' })
    .getByRole('listitem');
  await expect(gates).toHaveCount(4);
  await expect(gates.nth(0)).toContainText('Plan approved');
  await expect(gates.nth(1)).toContainText('Sequence refused');
  await expect(gates.nth(1)).toContainText('JG_AGENT_HQ_PLAN_INVALID');
  await expect(gates.nth(2)).toContainText('Sequence approved');
  await expect(gates.nth(3)).toContainText('Execution authorized');
  await expect(
    page
      .getByRole('article', { name: 'Local, private and recoverable' })
      .getByRole('list', { name: 'Snapshot and restore' })
      .getByRole('listitem'),
  ).toHaveText([/createHqSnapshot.*Captured while agents work/u, /restoreHqSnapshot/u]);
  const more = page.getByRole('region', { name: HOME_CONTENT.more.title });
  const items = more.getByRole('listitem');
  await expect(items).toHaveCount(HOME_CONTENT.more.items.length);
  for (const [index, item] of HOME_CONTENT.more.items.entries()) {
    await expect(items.nth(index)).toContainText(item.title);
    await expect(items.nth(index)).toContainText(item.name);
  }
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
  await page.getByRole('link', { name: 'Session walkthrough' }).click();
  await expect(page).toHaveURL('/examples/#control-session');
  const example = page.getByRole('article', { name: CONTROL_EXAMPLE.title });
  await expect(
    example.getByRole('list', { name: `${CONTROL_EXAMPLE.category} steps` }).getByRole('heading'),
  ).toHaveText(CONTROL_EXAMPLE.steps.map((step) => step.title));
  const tabs = example.getByRole('tablist', { name: `${CONTROL_EXAMPLE.category} walkthrough` });
  await expect(tabs.getByRole('tab', { name: 'Result' })).toHaveAttribute('aria-selected', 'true');
  await tabs.getByRole('tab', { name: 'Result' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(tabs.getByRole('tab', { name: 'Run it' })).toBeFocused();
  await expect(tabs.getByRole('tab', { name: 'Run it' })).toHaveAttribute('aria-selected', 'true');
  expect(
    await tabs
      .getByRole('tab', { name: 'Run it' })
      .evaluate((element) => getComputedStyle(element).outlineStyle),
  ).not.toBe('none');
  await page.keyboard.press('ArrowLeft');
  await expect(tabs.getByRole('tab', { name: 'Result' })).toHaveAttribute('aria-selected', 'true');
  await expect(example.getByRole('tabpanel', { name: 'Result' })).toContainText('acknowledged');
  await expect(example.getByRole('tabpanel', { name: 'Result' })).toContainText(
    'Turn completion and tool permissions are reported separately.',
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
    title: 'Have another agent review the work',
    category: 'Agent review',
    link: 'Review walkthrough',
    helper: 'reviewHandoff',
    boundary: 'Findings never approve implementation.',
    callback: 'confirmRequest',
  },
  {
    id: 'revise-plan',
    title: 'Change the plan. Keep verified work.',
    category: 'Plan revision',
    link: 'Revision walkthrough',
    helper: 'revisePlan',
    boundary: 'Editing a status in the file never counts as verified.',
    callback: 'approveSequence',
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
