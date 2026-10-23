import { expect, test } from '@playwright/test';
import { expectNoHorizontalOverflow, waitForPageAssets } from 'jg-playwright';

const DOCUMENTS = [
  {
    route: '/docs/',
    markdown: '/docs/index.md',
    source: 'README.md',
    heading: 'Installation',
    anchor: '#installation',
  },
  {
    route: '/docs/api/',
    markdown: '/docs/api/index.md',
    source: 'api/README.md',
    heading: 'Lock lifecycle',
    anchor: '#lock-lifecycle',
  },
] as const;

test.use({ contextOptions: { reducedMotion: 'reduce' } });

for (const colorScheme of ['light', 'dark'] as const) {
  for (const width of [320, 1440]) {
    for (const document of DOCUMENTS) {
      test(`${colorScheme} ${width}px ${document.route} preserves the complete outline and source actions`, async ({
        page,
      }) => {
        await page.emulateMedia({ colorScheme });
        await page.setViewportSize({ width, height: 900 });
        await page.goto(document.route);
        await waitForPageAssets(page);
        const outline = page.getByRole('navigation', { name: 'On this page', exact: true });
        if (width === 320) {
          const summary = outline.locator('summary');
          await summary.focus();
          await page.keyboard.press('Enter');
          await expect(summary).toHaveCSS('outline-style', 'solid');
        }
        const headings = await page
          .getByRole('main')
          .getByRole('heading', { level: 2 })
          .allTextContents();
        await expect(outline.getByRole('link')).toHaveText(headings);
        const section = outline.getByRole('link', { name: document.heading, exact: true });
        await section.focus();
        await page.keyboard.press('Enter');
        await expect(page).toHaveURL(document.route + document.anchor);
        await expect(
          page.getByRole('heading', { name: document.heading, exact: true }),
        ).toBeInViewport();
        await expect(
          page.getByRole('main').getByRole('link', { name: 'Markdown', exact: true }),
        ).toHaveAttribute('href', document.markdown);
        const source = page.getByRole('link', { name: 'Source (opens in a new tab)', exact: true });
        await expect(source).toHaveAttribute(
          'href',
          'https://github.com/jesusgraterol/jg-agent-hq/blob/main/' + document.source,
        );
        await expect(source).toHaveAttribute('target', '_blank');
        const markdown = await page.request.get(document.markdown);
        expect(markdown.status()).toBe(200);
        expect(await markdown.text()).toContain('## ' + document.heading);
        await expectNoHorizontalOverflow(page);
      });
    }
  }
}

test.describe('documentation without JavaScript', () => {
  test.use({ javaScriptEnabled: false });
  for (const colorScheme of ['light', 'dark'] as const) {
    for (const document of DOCUMENTS) {
      test(`${colorScheme} ${document.route} keeps the mobile outline and raw actions usable`, async ({
        page,
      }) => {
        await page.emulateMedia({ colorScheme });
        await page.setViewportSize({ width: 320, height: 900 });
        await page.goto(document.route);
        const outline = page.getByRole('navigation', { name: 'On this page', exact: true });
        await outline.locator('summary').focus();
        await page.keyboard.press('Space');
        await expect(
          outline.getByRole('link', { name: document.heading, exact: true }),
        ).toBeVisible();
        await outline.getByRole('link', { name: document.heading, exact: true }).click();
        await expect(
          page.getByRole('heading', { name: document.heading, exact: true }),
        ).toBeInViewport();
        await expect(
          page.getByRole('main').getByRole('link', { name: 'Markdown', exact: true }),
        ).toHaveAttribute('href', document.markdown);
        await expectNoHorizontalOverflow(page);
      });
    }
  }
});
