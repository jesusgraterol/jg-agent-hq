import { expectToRejectCode } from 'jg-exception/testing';
import { expect, test, vi } from 'vitest';

import { needsPublication, waitForPublication } from './release.ts';
import { archiveIntegrity, buildArchive, type IArchiveFile } from './testing/index.ts';
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

test("a release npm doesn't serve before the deadline fails saying a rerun finishes it", async () => {
  try {
    vi.stubGlobal('fetch', async () => new Response(null, { status: 404 }));
    await expectToRejectCode(
      waitForPublication('0.3.0', 'sha512-tested', 50),
      'JG_AGENT_HQ_RELEASE_CHECK_FAILED',
      "npm accepted 0.3.0 but didn't serve it before the deadline; rerun the publish job",
    );
  } finally {
    vi.unstubAllGlobals();
  }
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

// release integrity protects installation and runtime behavior, so these cases remain essential.
const originalFiles: IArchiveFile[] = [
  {
    name: 'package/package.json',
    content: JSON.stringify({
      name: 'jg-agent-hq',
      version: '0.3.0',
      scripts: { test: 'complete' },
    }),
  },
  { name: 'package/README.md', content: '# HQ\n\nUsage.\n' },
  { name: 'package/dist/index.js', content: 'export const result = 1;\n' },
];
const testingFiles: IArchiveFile[] = [
  {
    ...originalFiles[0]!,
    content: JSON.stringify({
      name: 'jg-agent-hq',
      version: '0.3.0',
      scripts: { test: 'essential', 'test:full': 'complete' },
    }),
  },
  {
    ...originalFiles[1]!,
    content:
      '# HQ\n\n[testing-commands:start]: #\nTesting commands.\n[testing-commands:end]: #\n\nUsage.\n',
  },
  originalFiles[2]!,
];

test('verified testing metadata reuses the published version without permitting publication', async () => {
  const previous = buildArchive(originalFiles);
  const candidate = buildArchive(testingFiles);
  const calls: string[] = [];
  let sharedSignal: AbortSignal | undefined;
  const fetcher: IRegistryFetch = async (url, init) => {
    calls.push(url);
    expect(init.redirect).toBe('error');
    if (sharedSignal) expect(init.signal).toBe(sharedSignal);
    else sharedSignal = init.signal ?? undefined;
    return url.endsWith('.tgz')
      ? new Response(new Uint8Array(previous))
      : published('0.3.0', archiveIntegrity(previous));
  };
  expect(await needsPublication('0.3.0', archiveIntegrity(candidate), fetcher, candidate)).toBe(
    false,
  );
  expect(calls).toStrictEqual([
    'https://registry.npmjs.org/jg-agent-hq/0.3.0',
    'https://registry.npmjs.org/jg-agent-hq/-/jg-agent-hq-0.3.0.tgz',
  ]);
  await expectToRejectCode(
    needsPublication('0.3.0', archiveIntegrity(candidate), fetcher),
    'JG_AGENT_HQ_RELEASE_CHECK_FAILED',
  );
});

test.each([
  ['runtime', [...testingFiles.slice(0, 2), { ...testingFiles[2]!, content: 'changed' }]],
  ['permissions', [...testingFiles.slice(0, 2), { ...testingFiles[2]!, mode: 0o755 }]],
  [
    'dependency',
    [
      {
        ...testingFiles[0]!,
        content: '{"name":"jg-agent-hq","version":"0.3.0","dependencies":{"library":"2"}}',
      },
      ...testingFiles.slice(1),
    ],
  ],
  [
    'installation hook',
    [
      {
        ...testingFiles[0]!,
        content: '{"name":"jg-agent-hq","version":"0.3.0","scripts":{"postinstall":"changed"}}',
      },
      ...testingFiles.slice(1),
    ],
  ],
  [
    'unmarked README',
    [testingFiles[0]!, { ...testingFiles[1]!, content: 'Changed usage.' }, testingFiles[2]!],
  ],
  ['file inventory', [...testingFiles, { name: 'package/new.js', content: 'added' }]],
])('testing changes cannot hide a changed %s', async (_label, files) => {
  const previous = buildArchive(originalFiles);
  const candidate = buildArchive(files);
  await expectToRejectCode(
    needsPublication(
      '0.3.0',
      archiveIntegrity(candidate),
      async (url) =>
        url.endsWith('.tgz')
          ? new Response(new Uint8Array(previous))
          : published('0.3.0', archiveIntegrity(previous)),
      candidate,
    ),
    'JG_AGENT_HQ_RELEASE_CHECK_FAILED',
    'published contents differ',
  );
});

test('candidate and registry archive bytes must independently match their raw SHA-512 identities', async () => {
  const previous = buildArchive(originalFiles);
  const candidate = buildArchive(testingFiles);
  let calls = 0;
  const fetcher: IRegistryFetch = async () => {
    calls++;
    return published('0.3.0', archiveIntegrity(previous));
  };
  await expectToRejectCode(
    needsPublication('0.3.0', archiveIntegrity(candidate), fetcher, previous),
    'JG_AGENT_HQ_RELEASE_CHECK_FAILED',
    'candidate archive integrity',
  );
  expect(calls).toBe(1);
  await expectToRejectCode(
    needsPublication(
      '0.3.0',
      archiveIntegrity(candidate),
      async (url) =>
        url.endsWith('.tgz')
          ? new Response(new Uint8Array(candidate))
          : published('0.3.0', archiveIntegrity(previous)),
      candidate,
    ),
    'JG_AGENT_HQ_RELEASE_CHECK_FAILED',
    'registry archive integrity',
  );
});

test.each([
  ['unavailable', () => new Response(null, { status: 503 })],
  ['oversized', () => new Response(new Uint8Array(16 * 1024 * 1024 + 1))],
  [
    'transport failure',
    () => {
      throw new Error('archive offline');
    },
  ],
])('a published archive that is %s never authorizes publication', async (_label, response) => {
  const previous = buildArchive(originalFiles);
  const candidate = buildArchive(testingFiles);
  await expectToRejectCode(
    needsPublication(
      '0.3.0',
      archiveIntegrity(candidate),
      async (url) =>
        url.endsWith('.tgz') ? response() : published('0.3.0', archiveIntegrity(previous)),
      candidate,
    ),
    'JG_AGENT_HQ_RELEASE_CHECK_FAILED',
  );
});
