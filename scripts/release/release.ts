import { createHash } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { Exception, extractMessage } from 'jg-exception';

import { samePublishedArchive } from './development-metadata/index.ts';
import { RegistryReleaseSchema, ReleaseVersionSchema, type IRegistryFetch } from './types.ts';

// how long npm may take to serve a release it accepted, which took over three minutes in 2026-10
const PUBLICATION_DEADLINE_MS = 600_000;
// how often the registry is asked for the release meanwhile
const PUBLICATION_POLL_MS = 5_000;

/**
 * Reads one exact npm version without redirects, unbounded bodies or indefinite network work.
 * @returns The validated release, or null only for an HTTP 404.
 * @throws
 * - JG_AGENT_HQ_RELEASE_CHECK_FAILED: The HQ package release check failed
 */
const readRelease = async (version: string, fetcher: IRegistryFetch, signal: AbortSignal) => {
  let response: Response;
  try {
    response = await fetcher(`https://registry.npmjs.org/jg-agent-hq/${version}`, {
      signal,
      redirect: 'error',
      headers: { Accept: 'application/json' },
    });
  } catch (cause) {
    throw new Exception(`The HQ package release check failed: ${extractMessage(cause)}`, {
      code: 'JG_AGENT_HQ_RELEASE_CHECK_FAILED',
      cause,
    });
  }
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel();
    throw new Exception(
      `The HQ package release check failed: registry returned HTTP ${response.status}`,
      { code: 'JG_AGENT_HQ_RELEASE_CHECK_FAILED' },
    );
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536)
        throw new Exception(
          'The HQ package release check failed: registry response exceeds 64 KiB',
          { code: 'JG_AGENT_HQ_RELEASE_CHECK_FAILED' },
        );
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (cause) {
    throw new Exception(`The HQ package release check failed: ${extractMessage(cause)}`, {
      code: 'JG_AGENT_HQ_RELEASE_CHECK_FAILED',
      cause,
    });
  }
  const parsed = RegistryReleaseSchema.safeParse(payload);
  if (!parsed.success)
    throw new Exception('The HQ package release check failed: registry metadata is invalid', {
      code: 'JG_AGENT_HQ_RELEASE_CHECK_FAILED',
    });
  const release = parsed.data;
  if (version !== 'latest' && release.version !== version)
    throw new Exception('The HQ package release check failed: registry returned another version', {
      code: 'JG_AGENT_HQ_RELEASE_CHECK_FAILED',
    });
  return release;
};

/**
 * Reads the fixed registry archive with the existing 16 MiB consumer limit and shared deadline.
 * The registry's SHA-512 is checked before any payload comparison.
 * @returns The verified published archive bytes.
 * @throws
 * - JG_AGENT_HQ_RELEASE_CHECK_FAILED: The HQ package release check failed
 */
const readPublishedArchive = async (
  version: string,
  integrity: string,
  fetcher: IRegistryFetch,
  signal: AbortSignal,
): Promise<Buffer> => {
  try {
    const response = await fetcher(
      `https://registry.npmjs.org/jg-agent-hq/-/jg-agent-hq-${version}.tgz`,
      { signal, redirect: 'error' },
    );
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      throw new Exception(
        `The HQ package release check failed: registry archive returned HTTP ${response.status}`,
        { code: 'JG_AGENT_HQ_RELEASE_CHECK_FAILED' },
      );
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 16 * 1024 * 1024)
          throw new Exception(
            'The HQ package release check failed: registry archive exceeds 16 MiB',
            { code: 'JG_AGENT_HQ_RELEASE_CHECK_FAILED' },
          );
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    const bytes = Buffer.concat(chunks);
    if (`sha512-${createHash('sha512').update(bytes).digest('base64')}` !== integrity)
      throw new Exception(
        'The HQ package release check failed: registry archive integrity differs from its metadata',
        { code: 'JG_AGENT_HQ_RELEASE_CHECK_FAILED' },
      );
    return bytes;
  } catch (cause) {
    if (cause instanceof Exception) throw cause;
    throw new Exception(`The HQ package release check failed: ${extractMessage(cause)}`, {
      code: 'JG_AGENT_HQ_RELEASE_CHECK_FAILED',
      cause,
    });
  }
};

/**
 * Skips matching protected contents of a published artifact and admits only a newer stable release.
 * Registry failures never authorize publication. No response is cached between runs.
 * @returns Whether the verified archive still needs publication.
 * @throws
 * - JG_AGENT_HQ_RELEASE_CHECK_FAILED: The HQ package release check failed
 */
export const needsPublication = async (
  version: string,
  integrity: string,
  fetcher: IRegistryFetch = fetch,
  candidateArchive?: Uint8Array,
): Promise<boolean> => {
  if (!ReleaseVersionSchema.safeParse(version).success)
    throw new Exception(
      'The HQ package release check failed: a stable semantic version is required',
      { code: 'JG_AGENT_HQ_RELEASE_CHECK_FAILED' },
    );
  const signal = AbortSignal.timeout(20000);
  const exact = await readRelease(version, fetcher, signal);
  if (exact) {
    if (exact.dist.integrity === integrity) return false;
    if (candidateArchive) {
      if (`sha512-${createHash('sha512').update(candidateArchive).digest('base64')}` !== integrity)
        throw new Exception(
          'The HQ package release check failed: candidate archive integrity does not match',
          {
            code: 'JG_AGENT_HQ_RELEASE_CHECK_FAILED',
          },
        );
      const published = await readPublishedArchive(version, exact.dist.integrity, fetcher, signal);
      if (samePublishedArchive(published, candidateArchive)) return false;
    }
    throw new Exception(
      'The HQ package release check failed: published contents differ; increment the package version',
      { code: 'JG_AGENT_HQ_RELEASE_CHECK_FAILED' },
    );
  }
  const latest = await readRelease('latest', fetcher, signal);
  if (!latest)
    throw new Exception(
      'The HQ package release check failed: the existing package has no latest release',
      { code: 'JG_AGENT_HQ_RELEASE_CHECK_FAILED' },
    );
  const currentParts = version.split('.').map(BigInt);
  const latestParts = latest.version.split('.').map(BigInt);
  for (let index = 0; index < currentParts.length; index++) {
    if (currentParts[index]! > latestParts[index]!) return true;
    if (currentParts[index]! < latestParts[index]!) break;
  }
  throw new Exception(
    'The HQ package release check failed: the new version must exceed the latest published version',
    { code: 'JG_AGENT_HQ_RELEASE_CHECK_FAILED' },
  );
};

/**
 * Waits for npm's asynchronous processing of one submitted release, checking its exact bytes.
 * When npm doesn't serve it in time, the release is still published: rerunning the job confirms
 * its archive and deploys the website.
 * @param version The submitted version.
 * @param integrity The tested archive's integrity.
 * @param deadlineMs How long npm may take to serve it.
 * @returns Completion once the registry serves the tested archive's integrity.
 * @throws
 * - JG_AGENT_HQ_RELEASE_CHECK_FAILED: The HQ package release check failed
 */
export const waitForPublication = async (
  version: string,
  integrity: string,
  deadlineMs = PUBLICATION_DEADLINE_MS,
): Promise<void> => {
  if (!ReleaseVersionSchema.safeParse(version).success)
    throw new Exception(
      'The HQ package release check failed: a stable semantic version is required',
      { code: 'JG_AGENT_HQ_RELEASE_CHECK_FAILED' },
    );
  const signal = AbortSignal.timeout(deadlineMs);
  try {
    for (;;) {
      const release = await readRelease(version, fetch, signal);
      if (release) {
        if (release.dist.integrity !== integrity)
          throw new Exception(
            'The HQ package release check failed: published contents differ from the tested archive',
            { code: 'JG_AGENT_HQ_RELEASE_CHECK_FAILED' },
          );
        return;
      }
      await setTimeout(PUBLICATION_POLL_MS, undefined, { signal });
    }
  } catch (error) {
    if (!signal.aborted) throw error;
    throw new Exception(
      `The HQ package release check failed: npm accepted ${version} but didn't serve it before the deadline; rerun the publish job, which confirms the published archive and deploys the website`,
      { code: 'JG_AGENT_HQ_RELEASE_CHECK_FAILED', cause: error },
    );
  }
};
