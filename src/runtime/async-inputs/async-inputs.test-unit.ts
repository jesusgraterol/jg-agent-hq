import { expect, test } from 'vitest';

import { createAsyncInputs } from './index.js';
import type { IAsyncInputEvent } from './index.js';

test('a persistently failing listener cannot hide recovery from a later successful enqueue or stop another listener', () => {
  const observations = createAsyncInputs();
  const recovered: IAsyncInputEvent[] = [];
  const unaffected: IAsyncInputEvent[] = [];
  let isFailing = true;
  observations.subscribe((event) => {
    if (isFailing) throw new Error('Host storage unavailable');
    recovered.push(event);
  });
  observations.subscribe((event) => unaffected.push(event));
  expect(unaffected).toHaveLength(1);
  isFailing = false;
  observations.emit({ kind: 'recovery', provider: 'codex', source: null, reason: 'reconnect' });
  expect(recovered).toStrictEqual([
    { kind: 'recovery', provider: 'codex', source: null, reason: 'listener-failed' },
    { kind: 'recovery', provider: 'codex', source: null, reason: 'reconnect' },
  ]);
  expect(unaffected).toStrictEqual([
    { kind: 'recovery', provider: 'codex', source: null, reason: 'subscribed' },
    { kind: 'recovery', provider: 'codex', source: null, reason: 'reconnect' },
  ]);
  observations.close();
});

test('duplicate subscriptions own independent idempotent teardown and closing discards every callback', () => {
  const observations = createAsyncInputs();
  const events: IAsyncInputEvent[] = [];
  const listener = (event: IAsyncInputEvent): void => {
    events.push(event);
  };
  const stopFirst = observations.subscribe(listener);
  const stopSecond = observations.subscribe(listener);
  stopFirst();
  stopFirst();
  observations.emit({ kind: 'recovery', provider: 'codex', source: null, reason: 'reconnect' });
  expect(events.map((event) => event.kind === 'recovery' && event.reason)).toStrictEqual([
    'subscribed',
    'subscribed',
    'reconnect',
  ]);
  stopSecond();
  expect(observations.hasListeners()).toBe(false);
  observations.subscribe(listener);
  observations.close();
  const count = events.length;
  observations.emit({ kind: 'recovery', provider: 'codex', source: null, reason: 'reconnect' });
  observations.subscribe(listener)();
  expect(events).toHaveLength(count);
  expect(observations.hasListeners()).toBe(false);
});
