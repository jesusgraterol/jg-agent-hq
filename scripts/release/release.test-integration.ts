import { expectToRejectCode } from 'jg-exception/testing';
import { expect, test, vi } from 'vitest';

import { needsPublication, waitForPublication } from './release.ts';
import type { IRegistryFetch } from './types.ts';

const published = (version: string, integrity = 'sha512-tested') =>
  Response.json({ name: 'jg-agent-hq', version, dist: { integrity } });

test('a new release requires an exact 404 and a strictly lower published version', async () => {
  const urls: string[] = [];
  const fetcher: IRegistryFetch = async (url, init) => {
    urls.push(url);
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    return url.endsWith('/latest') ? published('0.2.9') : new Response(null, { status: 404 });
  };
  await expect(needsPublication('0.3.0', 'sha512-tested', fetcher)).resolves.toBe(true);
  expect(urls).toStrictEqual([
    'https://registry.npmjs.org/jg-agent-hq/0.3.0',
    'https://registry.npmjs.org/jg-agent-hq/latest',
  ]);
});

test('rerunning a release skips the exact already-published artifact without another lookup', async () => {
  let calls = 0;
  await expect(
    needsPublication('0.3.0', 'sha512-tested', async () => {
      calls++;
      return published('0.3.0');
    }),
  ).resolves.toBe(false);
  expect(calls).toBe(1);
});

test.each(['0.2.0', '0.3.0'])('rejects unpublished %s when latest is 0.3.0', async (version) => {
  await expectToRejectCode(
    needsPublication(version, 'sha512-tested', async (url) =>
      url.endsWith('/latest') ? published('0.3.0') : new Response(null, { status: 404 }),
    ),
    'JG_AGENT_HQ_RELEASE_CHECK_FAILED',
    'The HQ package release check failed',
  );
});

test.each([
  () => new Response(null, { status: 500 }),
  () => new Response(null, { status: 401 }),
  () => new Response('not json'),
  () => Response.json({ name: 'other', version: '0.3.0', dist: { integrity: 'sha512-tested' } }),
  () => published('0.3.1'),
  () => published('0.3.0', 'sha512-different'),
  () => new Response('x'.repeat(65537)),
])('registry failure or mismatched content never permits publication (%#)', async (response) => {
  await expect(
    needsPublication('0.3.0', 'sha512-tested', async () => response()),
  ).rejects.toThrow();
});

test('registry transport failure never becomes permission to publish', async () => {
  await expect(
    needsPublication('0.3.0', 'sha512-tested', async () => {
      throw new Error('offline');
    }),
  ).rejects.toThrow('offline');
});

test('publication visibility requires the exact submitted archive integrity', async () => {
  try {
    vi.stubGlobal('fetch', async () => published('0.3.0'));
    await expect(waitForPublication('0.3.0', 'sha512-tested')).resolves.toBeUndefined();
    vi.stubGlobal('fetch', async () => published('0.3.0', 'sha512-different'));
    await expect(waitForPublication('0.3.0', 'sha512-tested')).rejects.toThrow(
      'published contents differ from the tested archive',
    );
  } finally {
    vi.unstubAllGlobals();
  }
});
