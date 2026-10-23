import { lstat, mkdir, realpath, rm, rmdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { generateRandomBytes, hashValue } from 'jg-crypto';
import { Exception, extractMessage } from 'jg-exception';
import { assertPrivateDirectory, readPrivateFile, writePrivateFile } from 'jg-fs';

import { isPrivateOwner } from '../../locks/index.js';

import { collaborationForbidden, collaborationConflict } from '../grants/index.js';
import {
  BridgeCredentialSchema,
  NativeToolBindingSchema,
  type INativeToolBinding,
  type IBridgeCredential,
  type IAgentCredentialLease,
} from './types.js';

// covers an escaped maximum filesystem path and the fixed credential fields
const CREDENTIAL_FILE_BYTES = 32_768;

/**
 * Reads only a private runtime-issued bridge file. Parser diagnostics may contain secret bytes.
 * @returns The transport credential, never a model-visible argument.
 * @throws
 * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
 */
export const readBridgeCredential = async (filePath: string): Promise<IBridgeCredential> => {
  try {
    const root = dirname(filePath);
    if (
      !isAbsolute(filePath) ||
      !/^jg-hq-tools-[a-f0-9-]{36}$/.test(basename(root)) ||
      !/^[a-f0-9]{32}\.json$/.test(basename(filePath))
    )
      return collaborationForbidden();
    await assertPrivateDirectory(root);
    const details = await lstat(filePath);
    if (
      !details.isFile() ||
      details.nlink !== 1 ||
      !isPrivateOwner(details) ||
      !isPrivateOwner(await lstat(root))
    )
      return collaborationForbidden();
    const bytes = await readPrivateFile(filePath, {
      maxBytes: CREDENTIAL_FILE_BYTES,
      rootPath: root,
    });
    const credential = BridgeCredentialSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    );
    if (basename(root) !== `jg-hq-tools-${credential.runtimeEpoch}`)
      return collaborationForbidden();
    return credential;
  } catch {
    // Do not retain credential contents in parser causes or authentication diagnostics.
    return collaborationForbidden();
  }
};

/**
 * Owns connection-scoped opaque credentials and their private files for one runtime epoch.
 * @returns Issuance, lookup, revocation and confirmed cleanup; credentials never enter SQLite.
 */
export const createAgentCredentials = (stateRoot: string, runtimeEpoch: string) => {
  const credentials = new Map<string, INativeToolBinding>();
  const leases = new Map<string, Promise<IAgentCredentialLease>>();
  const files = new Set<string>();
  let directory: Promise<string> | undefined;
  let ownedDirectory: string | undefined;
  let isClosed = false;
  let closing: Promise<void> | undefined;
  const root = (): Promise<string> =>
    (directory ??= (async () => {
      const path = join(await realpath(tmpdir()), `jg-hq-tools-${runtimeEpoch}`);
      await mkdir(path, { mode: 0o700 });
      ownedDirectory = path;
      await assertPrivateDirectory(path);
      if (!isPrivateOwner(await lstat(path))) return collaborationForbidden();
      return path;
    })());

  /**
   * Creates a credential, coalescing simultaneous setup for the same native connection.
   * @returns A private file lease; release revokes authority before deleting the file.
   * @throws
   * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
   * - JG_AGENT_HQ_COLLABORATION_CONFLICT: The HQ collaboration operation conflicts with its recorded state
   * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
   */
  const issue = async (binding: INativeToolBinding): Promise<IAgentCredentialLease> => {
    const selected = NativeToolBindingSchema.parse(binding);
    if (isClosed || selected.runtimeEpoch !== runtimeEpoch) return collaborationForbidden();
    const key = JSON.stringify([selected.provider, selected.nativeId]);
    const existing = leases.get(key);
    if (existing) return existing;
    if (leases.size >= 32) return collaborationConflict();
    const pending = (async () => {
      let filePath: string | undefined;
      const credential = generateRandomBytes(32, 'hex');
      const digest = hashValue(credential);
      try {
        const parent = await root();
        if (isClosed) return collaborationForbidden();
        filePath = join(parent, `${generateRandomBytes(16, 'hex')}.json`);
        await writePrivateFile(filePath, JSON.stringify({ stateRoot, runtimeEpoch, credential }), {
          rootPath: parent,
          isExclusive: true,
        });
        files.add(filePath);
        if (isClosed) return collaborationForbidden();
        credentials.set(digest, selected);
        const path = filePath;
        let release: Promise<void> | undefined;
        return {
          filePath: path,
          release: () =>
            (release ??= (async () => {
              credentials.delete(digest);
              leases.delete(key);
              await rm(path, { force: true });
              files.delete(path);
            })()),
        };
      } catch (cause) {
        credentials.delete(digest);
        leases.delete(key);
        try {
          if (filePath && files.has(filePath)) {
            await rm(filePath, { force: true });
            files.delete(filePath);
          }
        } catch (cleanup) {
          throw new Exception(`The HQ transport failed: ${extractMessage(cleanup)}`, {
            code: 'JG_AGENT_HQ_TRANSPORT_FAILED',
            data: { kind: 'operation-failed' },
            cause: new AggregateError([cause, cleanup], 'HQ agent bridge setup and cleanup failed'),
          });
        }
        throw new Exception(`The HQ transport failed: ${extractMessage(cause)}`, {
          code: 'JG_AGENT_HQ_TRANSPORT_FAILED',
          data: { kind: 'operation-failed' },
          cause,
        });
      }
    })();
    leases.set(key, pending);
    return pending;
  };

  /**
   * Resolves a current credential without trusting native or model-supplied sender labels.
   * @returns Its server-owned native binding.
   * @throws
   * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
   */
  const resolve = (credential: string): INativeToolBinding => {
    const binding = isClosed ? undefined : credentials.get(hashValue(credential));
    if (!binding) return collaborationForbidden();
    return { ...binding };
  };

  /**
   * Revokes credentials and removes known owned files before removing their private directory.
   * @returns Confirmed cleanup of this runtime's bridge files.
   * @throws
   * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
   */
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      isClosed = true;
      credentials.clear();
      await Promise.allSettled([...leases.values()]);
      if (directory) await Promise.allSettled([directory]);
      try {
        await Promise.all(
          [...files].map(async (path) => {
            await rm(path, { force: true });
            files.delete(path);
          }),
        );
        if (ownedDirectory) await rmdir(ownedDirectory);
        leases.clear();
      } catch (cause) {
        throw new Exception(`The HQ transport failed: ${extractMessage(cause)}`, {
          code: 'JG_AGENT_HQ_TRANSPORT_FAILED',
          data: { kind: 'operation-failed' },
          cause,
        });
      }
    })());
  return { issue, resolve, close };
};
