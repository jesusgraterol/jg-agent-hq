import { readFile } from 'node:fs/promises';
import { expectToThrowCode } from 'jg-exception/testing';
import { expect, test } from 'vitest';

import { HQ_ERROR_ENTRIES, HQ_ERRORS } from './index.js';

// the code and stable message of every row in the error reference's runtime and transport table
const readDocumentedErrors = async (): Promise<Record<string, string>> => {
  const reference = await readFile(new URL('../../errors/README.md', import.meta.url), 'utf8');
  const section = reference.split('## Runtime and transport')[1]!.split('\n## ')[0]!;
  return Object.fromEntries(
    [...section.matchAll(/^\| (JG_AGENT_HQ_[A-Z_]+) +\| (.+?) +\|$/gm)].map((row) => [
      row[1],
      row[2],
    ]),
  );
};

test('the error catalog holds exactly the codes and stable messages the error reference lists', async () => {
  expect(
    Object.fromEntries(Object.values(HQ_ERROR_ENTRIES).map(({ code, message }) => [code, message])),
  ).toStrictEqual(await readDocumentedErrors());
});

test.each(Object.entries(HQ_ERROR_ENTRIES))(
  "HQ_ERRORS.create('%s') -> its documented code and message, with its safe kind",
  (kind, { code, message }) => {
    const error = HQ_ERRORS.create(kind as keyof typeof HQ_ERROR_ENTRIES, {
      data: { kind: 'state-conflict' },
    });
    expectToThrowCode(
      () => {
        throw error;
      },
      code,
      message,
    );
    expect(error.message).toBe(message);
    expect(error.data).toStrictEqual({ kind: 'state-conflict' });
    expect(HQ_ERRORS.is(error, kind as keyof typeof HQ_ERROR_ENTRIES)).toBe(true);
  },
);
