import type { IAgentHq, requestAgentHq } from 'jg-agent-hq';
import type { IActionReceipt, IHqResponse, IThreadsPage } from 'jg-agent-hq/contracts';
import { expectTypeOf, test } from 'vitest';

/*
 * Only the types are checked, by `pnpm typecheck`: these functions are never called, so no
 * runtime or socket is needed.
 */
declare const runtime: IAgentHq;
declare const request: typeof requestAgentHq;

test('request resolves to the response of its command kind, without a cast', () => {
  const readThreads = () => runtime.request({ kind: 'threads', workspaceRoots: ['/workspace'] });
  expectTypeOf(readThreads).returns.resolves.toEqualTypeOf<{
    kind: 'threads';
    result: IThreadsPage;
  }>();
  const readReceipt = () =>
    runtime.request({ kind: 'receipt', actionId: '00000000-0000-4000-8000-000000000000' });
  expectTypeOf(readReceipt).returns.resolves.toEqualTypeOf<{
    kind: 'receipt';
    result: IActionReceipt | null;
  }>();
});

test('requestAgentHq resolves to the response of its command kind, without a cast', () => {
  const readThreads = () => request('/state', { kind: 'threads', workspaceRoots: ['/workspace'] });
  expectTypeOf(readThreads).returns.resolves.toEqualTypeOf<{
    kind: 'threads';
    result: IThreadsPage;
  }>();
});

test('a command whose kind is only known as a union resolves to any response', () => {
  const readAny = (command: Parameters<IAgentHq['request']>[0]) => runtime.request(command);
  expectTypeOf(readAny).returns.resolves.toEqualTypeOf<IHqResponse>();
});
