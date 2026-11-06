import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expectToRejectCode } from 'jg-exception/testing';
import { expect, test } from 'vitest';

import { createCodexProvider } from '../../../dist/providers/codex/index.js';

import { withClaudeRuntime, writeFixtureControl } from '../../../scripts/test-support/index.js';

test('explicit native rejections release bounded workspace request tracking', async () => {
  await withClaudeRuntime(async (fixture) => {
    await fixture.runtime.close();
    const native = await createCodexProvider();
    try {
      const thread = await native.startThread(`${randomUUID()}:create`, fixture.workspaceRoot);
      const away = join(fixture.workspaceRoot, 'part-b');
      await mkdir(away);
      await writeFixtureControl(fixture.root, 'control.json', { rejectTurn: true });
      for (let index = 0; index < 32; index += 1)
        await expectToRejectCode(
          native.startTurn(
            `${randomUUID()}:workspace`,
            thread.id,
            'Rejected input',
            null,
            {},
            [],
            away,
          ),
          'JG_AGENT_HQ_CODEX_FAILED',
          'Synthetic input rejection',
        );
      await writeFixtureControl(fixture.root, 'control.json', {});
      const accepted = await native.startTurn(
        `${randomUUID()}:workspace`,
        thread.id,
        'Accepted input',
        null,
        {},
        [],
        away,
      );
      expect(accepted.id).toBe('native-turn-1');
      expect((await native.readThread(thread.id)).workspaceRoot).toBe(away);
    } finally {
      await native.close();
    }
  });
});
