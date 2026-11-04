import { expectToThrowCode } from 'jg-exception/testing';
import { EvidenceRequestSchema } from 'jg-agent-hq/contracts';
import { expect, test } from 'vitest';

import { buildEvidencePage, evidencePosition, nativeProvenance } from './index.js';

test('a response that cannot represent even one native identity fails rather than returning a non-progressing cursor', () => {
  const command = EvidenceRequestSchema.parse({
    kind: 'session-evidence',
    provider: 'codex',
    workspaceRoot: '/workspace',
    nativeId: '\u0000'.repeat(4096),
  });
  const item = {
    nativeId: '\u0000'.repeat(4096),
    turnId: '\u0000'.repeat(4096),
    nativeType: 'agentMessage',
    kind: 'agent-message' as const,
    text: 'bounded',
    isTruncated: false,
    callId: null,
    outcome: null,
    files: [],
    provenance: nativeProvenance('agent-message'),
    createdAt: null,
  };
  expectToThrowCode(
    () => buildEvidencePage(command, evidencePosition(command), [item], null),
    'JG_AGENT_HQ_PROVIDER_FAILED',
  );
});

test('unknown native content is explicitly incomplete; evidence cannot claim fresh authority', () => {
  const command = EvidenceRequestSchema.parse({
    kind: 'session-evidence',
    provider: 'codex',
    workspaceRoot: '/workspace',
    nativeId: 'thread',
  });
  const page = buildEvidencePage(
    command,
    evidencePosition(command),
    [
      {
        nativeId: 'unknown',
        turnId: 'turn',
        nativeType: 'unrecognized',
        kind: 'unsupported',
        text: '',
        isTruncated: false,
        callId: null,
        outcome: null,
        files: [],
        provenance: nativeProvenance('unsupported'),
        createdAt: null,
      },
    ],
    null,
  );
  expect(page.data[0]).toMatchObject({
    isComplete: false,
    contentState: 'unsupported',
    provenance: { origin: 'unknown', source: 'unknown', grantsAuthority: false },
  });
  expect(page.nextCursor).toBeNull();
});

test('long native continuations cannot exceed the response budget after a complete source page', () => {
  const command = EvidenceRequestSchema.parse({
    kind: 'session-evidence',
    provider: 'codex',
    workspaceRoot: '/workspace',
    nativeId: 'thread',
  });
  const page = buildEvidencePage(
    command,
    evidencePosition(command),
    [
      {
        nativeId: 'item',
        turnId: 'turn',
        nativeType: 'agentMessage',
        kind: 'agent-message',
        text: 'x'.repeat(32_000),
        isTruncated: false,
        callId: null,
        outcome: null,
        files: [],
        provenance: nativeProvenance('agent-message'),
        createdAt: null,
      },
    ],
    'n'.repeat(8192),
  );
  expect(
    Buffer.byteLength(
      JSON.stringify({
        id: '00000000-0000-4000-8000-000000000000',
        success: true,
        response: { kind: 'session-evidence', result: page },
      }),
    ),
  ).toBeLessThanOrEqual(65_536);
  expect(page.data[0]?.isComplete).toBe(true);
  expect(page.nextCursor).not.toBeNull();
});

test('an evidence cursor continues only the request it came from, and a tampered one fails', () => {
  const command = EvidenceRequestSchema.parse({
    kind: 'session-evidence',
    provider: 'codex',
    workspaceRoot: '/workspace',
    nativeId: 'thread',
  });
  const page = buildEvidencePage(command, evidencePosition(command), [], 'native-source-page-2');
  const cursor = page.nextCursor!;
  expect(evidencePosition({ ...command, cursor })).toStrictEqual({
    sourceCursor: 'native-source-page-2',
    digest: null,
    index: 0,
    offset: 0,
  });
  const another = { ...command, nativeId: 'another' };
  expectToThrowCode(() => evidencePosition({ ...another, cursor }), 'JG_AGENT_HQ_CURSOR_INVALID');
  expectToThrowCode(
    () =>
      evidencePosition({
        ...command,
        cursor: `${cursor.slice(0, 8)}${cursor[8] === 'A' ? 'B' : 'A'}${cursor.slice(9)}`,
      }),
    'JG_AGENT_HQ_CURSOR_INVALID',
  );
});
