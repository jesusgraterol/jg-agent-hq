import { expectToThrowCode } from 'jg-exception/testing';
import { expect, test } from 'vitest';

import { HQ_ERROR_ENTRIES, HQ_ERRORS } from './index.js';

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
