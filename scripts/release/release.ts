import { setTimeout } from 'node:timers/promises';
import { Exception, extractMessage } from 'jg-exception';

import { RegistryReleaseSchema, ReleaseVersionSchema, type IRegistryFetch } from './types.ts';

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
 * Skips an identical published artifact and admits only a newer stable release.
 * Registry failures never authorize publication. No response is cached between runs.
 * @returns Whether the verified archive still needs publication.
 * @throws
 * - JG_AGENT_HQ_RELEASE_CHECK_FAILED: The HQ package release check failed
 */
export const needsPublication = async (
  version: string,
  integrity: string,
  fetcher: IRegistryFetch = fetch,
): Promise<boolean> => {
  if (!ReleaseVersionSchema.safeParse(version).success)
    throw new Exception(
      'The HQ package release check failed: a stable semantic version is required',
      { code: 'JG_AGENT_HQ_RELEASE_CHECK_FAILED' },
    );
  const signal = AbortSignal.timeout(20000);
  const exact = await readRelease(version, fetcher, signal);
  if (exact) {
    if (exact.dist.integrity !== integrity)
      throw new Exception(
        'The HQ package release check failed: published contents differ; increment the package version',
        { code: 'JG_AGENT_HQ_RELEASE_CHECK_FAILED' },
      );
    return false;
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
 * @returns Completion once the registry serves the tested archive's integrity.
 * @throws
 * - JG_AGENT_HQ_RELEASE_CHECK_FAILED: The HQ package release check failed
 */
export const waitForPublication = async (version: string, integrity: string): Promise<void> => {
  if (!ReleaseVersionSchema.safeParse(version).success)
    throw new Exception(
      'The HQ package release check failed: a stable semantic version is required',
      { code: 'JG_AGENT_HQ_RELEASE_CHECK_FAILED' },
    );
  const signal = AbortSignal.timeout(180000);
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
    await setTimeout(5000, undefined, { signal });
  }
};
