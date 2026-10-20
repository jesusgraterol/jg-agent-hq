import { satteri } from '@astrojs/markdown-satteri';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';
import { codeWindowPlugin } from 'jg-personal-astro-ui/code-window-plugin';
import { externalLinkPlugin } from 'jg-personal-astro-ui/external-link-plugin';
import { SYNTAX_THEME } from 'jg-personal-astro-ui/syntax-theme';

import { canonicalMarkdownPlugin } from './src/content/index.ts';
import { SITE_CONFIG } from './src/site.config.ts';

export default defineConfig({
  site: SITE_CONFIG.url,
  output: 'static',
  trailingSlash: 'always',
  integrations: [sitemap({ filter: (page) => !page.endsWith('/404/') })],
  markdown: {
    shikiConfig: { theme: SYNTAX_THEME, wrap: true },
    processor: satteri({
      features: { smartPunctuation: false },
      mdastPlugins: [canonicalMarkdownPlugin],
      hastPlugins: [codeWindowPlugin, externalLinkPlugin({ siteUrl: SITE_CONFIG.url })],
    }),
  },
  vite: { plugins: [tailwindcss()] },
});
