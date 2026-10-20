import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { Exception, extractMessage } from 'error-message-utils';

const WEBSITE_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Renders the social image and family favicons using pinned Chromium and bundled fonts.
 * @returns Completion after every image is written and Chromium closes.
 * @throws
 * - -1: The HQ website assets could not be generated
 */
export const generateAssets = async (outputRoot: string): Promise<void> => {
  const browser = await chromium.launch();
  try {
    const dataFont = async (name: string, filename: string): Promise<string> => {
      const path = fileURLToPath(
        import.meta.resolve(`@fontsource-variable/${name}/files/${filename}`),
      );
      return `data:font/woff2;base64,${(await readFile(path)).toString('base64')}`;
    };
    const template = await readFile(new URL('./open-graph.html', import.meta.url), 'utf8');
    const mark = await readFile(
      fileURLToPath(import.meta.resolve('jg-personal-astro-ui/jg-mark.svg')),
      'utf8',
    );
    const favicon = await readFile(
      fileURLToPath(import.meta.resolve('jg-personal-astro-ui/jg-favicon.svg')),
      'utf8',
    );
    const html = template
      .replace('{{sans}}', await dataFont('ubuntu-sans', 'ubuntu-sans-latin-wght-normal.woff2'))
      .replace(
        '{{mono}}',
        await dataFont('ubuntu-sans-mono', 'ubuntu-sans-mono-latin-wght-normal.woff2'),
      )
      .replace('{{mark}}', mark);
    const page = await browser.newPage({
      viewport: { width: 1200, height: 630 },
      deviceScaleFactor: 1,
    });
    await page.route('**/*', (route) => route.abort());
    await page.setContent(html);
    await page.evaluate(async () => {
      await document.fonts.ready;
      await document.fonts.load('650 94px "Ubuntu Sans"');
      await document.fonts.load('400 28px "Ubuntu Mono"');
    });
    const fits = await page.evaluate(
      () =>
        document.fonts.check('650 94px "Ubuntu Sans"') &&
        document.fonts.check('400 28px "Ubuntu Mono"') &&
        [...document.fonts].every((font) => font.status === 'loaded') &&
        [...document.querySelectorAll('[data-fit]')].every((element) => {
          const box = element.getBoundingClientRect();
          return (
            box.x >= 0 &&
            box.y >= 0 &&
            box.right <= 1200 &&
            box.bottom <= 630 &&
            element.scrollWidth <= element.clientWidth
          );
        }),
    );
    if (!fits) throw new Exception('The HQ website assets could not be generated');
    await mkdir(resolve(outputRoot, 'og'), { recursive: true });
    await mkdir(resolve(outputRoot, 'favicons'), { recursive: true });
    await page.screenshot({ path: resolve(outputRoot, 'og/jg-agent-hq.png') });
    const icoImages: Buffer[] = [];
    for (const size of [16, 32, 48, 192]) {
      await page.setViewportSize({ width: size, height: size });
      await page.setContent(
        `<html><body style="margin:0">${favicon.replace('width="64" height="64"', `width="${size}" height="${size}"`)}</body></html>`,
      );
      const png = await page.screenshot({ omitBackground: true });
      if (size !== 192) icoImages.push(png);
      if (size === 32 || size === 192)
        await writeFile(resolve(outputRoot, `favicons/${size}x${size}.png`), png);
    }
    const header = Buffer.alloc(6 + icoImages.length * 16);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(icoImages.length, 4);
    let offset = header.length;
    for (const [index, png] of icoImages.entries()) {
      const cursor = 6 + index * 16;
      const size = [16, 32, 48][index]!;
      header[cursor] = size;
      header[cursor + 1] = size;
      header.writeUInt16LE(1, cursor + 4);
      header.writeUInt16LE(32, cursor + 6);
      header.writeUInt32LE(png.length, cursor + 8);
      header.writeUInt32LE(offset, cursor + 12);
      offset += png.length;
    }
    await writeFile(resolve(outputRoot, 'favicon.ico'), Buffer.concat([header, ...icoImages]));
  } catch (cause) {
    throw new Exception(
      `The HQ website assets could not be generated: ${extractMessage(cause)}`,
      undefined,
      undefined,
      { cause },
    );
  } finally {
    await browser.close();
  }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await generateAssets(resolve(WEBSITE_ROOT, 'public'));
