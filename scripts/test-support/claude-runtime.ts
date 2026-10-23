import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasErrorCode } from 'jg-exception';
import { createAgentHq, requestAgentHq, type IAgentHq, type IAgentHqOptions } from 'jg-agent-hq';
import type { IHqRequestInput } from 'jg-agent-hq/contracts';
import { expect, onTestFinished, vi } from 'vitest';
import { z } from 'zod';

import { installClaudeFixture } from './claude.js';
import { installCodexFixture } from './codex.js';
import { writeFixtureControl } from './controls.js';

// owned filesystem/native setup shared by Claude usage and history integration tests
export type IClaudeFixture = {
  root: string;
  stateRoot: string;
  workspaceRoot: string;
  projectRoot: string;
  configRoot: string;
  runtime: IAgentHq;
  request(command: IHqRequestInput): ReturnType<typeof requestAgentHq>;
  control(settings: object): Promise<void>;
  transcript(nativeId: string): string;
};

/** Runs the real runtime and verifies native process teardown before deleting its fixture. */
export const withClaudeRuntime = async (
  run: (fixture: IClaudeFixture) => Promise<void>,
  options: Pick<
    IAgentHqOptions,
    'parsePlanContract' | 'coordinationRoot' | 'providerFactories'
  > = {},
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'jg-hq-claude-'));
  const stateRoot = join(root, 'state');
  const workspaceRoot = join(root, 'workspace');
  const configRoot = join(root, 'claude');
  const projectRoot = join(configRoot, 'projects', workspaceRoot.replace(/[^a-zA-Z0-9]/g, '-'));
  let runtime: IAgentHq | undefined;
  let canRemoveFixture = false;
  let teardown: Promise<void> | undefined;
  const cleanup = (): Promise<void> =>
    (teardown ??= (async () => {
      try {
        await runtime?.close();
        try {
          await lstat(join(stateRoot, 'hq-owner.json'));
          throw new Error(`Fixture ownership requires inspection at ${stateRoot}`);
        } catch (cause) {
          if (!hasErrorCode(cause, 'ENOENT')) throw cause;
        }
        let children: string[] = [];
        for (const filename of ['claude-pids.jsonl', 'claude-read-pids.jsonl']) {
          try {
            children.push(
              ...(await readFile(join(root, filename), 'utf8')).trim().split('\n').filter(Boolean),
            );
          } catch (cause) {
            if (!hasErrorCode(cause, 'ENOENT')) throw cause;
          }
        }
        for (const line of children)
          for (const pid of Object.values(z.record(z.string(), z.number()).parse(JSON.parse(line))))
            expect(() => process.kill(pid, 0)).toThrow();
        for (const filename of ['pids.json', 'claude-pid.json']) {
          let pids: number[];
          try {
            const record = z
              .record(z.string(), z.number())
              .parse(JSON.parse(await readFile(join(root, filename), 'utf8')));
            pids = Object.values(record);
          } catch (cause) {
            if (hasErrorCode(cause, 'ENOENT')) continue;
            throw cause;
          }
          for (const pid of pids) {
            expect(() => process.kill(pid, 0)).toThrow();
          }
        }
        canRemoveFixture = true;
      } finally {
        vi.unstubAllEnvs();
        if (canRemoveFixture) await rm(root, { recursive: true, force: true });
      }
    })());
  onTestFinished(cleanup);
  try {
    await mkdir(workspaceRoot);
    await mkdir(projectRoot, { recursive: true });
    const bin = await installCodexFixture(root);
    await installClaudeFixture(root);
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    vi.stubEnv('JG_HQ_FIXTURE_DIRECTORY', root);
    vi.stubEnv('JG_HQ_FIXTURE_WORKSPACE', workspaceRoot);
    vi.stubEnv('CLAUDE_CONFIG_DIR', configRoot);
    runtime = await createAgentHq({ stateRoot, allowedRoots: [workspaceRoot], ...options });
    await run({
      root,
      stateRoot,
      workspaceRoot,
      projectRoot,
      configRoot,
      runtime,
      request: (command) => requestAgentHq(stateRoot, command),
      control: (settings) => writeFixtureControl(root, 'claude-control.json', settings),
      transcript: (nativeId) => join(projectRoot, `${nativeId}.jsonl`),
    });
  } finally {
    await cleanup();
  }
};

/** Makes one supported top-level native record while keeping all transcript fields realistic. */
export const claudeRecord = (
  workspaceRoot: string,
  sessionId: string,
  options: {
    uuid?: string;
    parentUuid?: string | null;
    type?: 'user' | 'assistant';
    text?: string;
    timestamp?: string;
  } = {},
) => ({
  type: options.type ?? 'user',
  uuid: options.uuid ?? randomUUID(),
  parentUuid: options.parentUuid ?? null,
  sessionId,
  cwd: workspaceRoot,
  version: '2.1.304',
  isSidechain: false,
  timestamp: options.timestamp ?? '2026-10-19T12:00:00.000Z',
  message: { role: options.type ?? 'user', content: options.text ?? 'Example native message' },
});
