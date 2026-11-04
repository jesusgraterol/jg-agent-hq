import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

import { STATEMENT_CACHE_CAPACITY } from './constants.js';

/**
 * Lists the Node.js options a worker thread inherits, without the string-input mode its caller
 * may have used, because a worker loads a file.
 * @returns The options to pass as the worker's `execArgv`.
 */
export const toWorkerExecArgv = (): string[] =>
  process.execArgv.filter(
    (argument, index, options) =>
      argument !== '--input-type' &&
      !argument.startsWith('--input-type=') &&
      options[index - 1] !== '--input-type',
  );

/*
 * SQLite's tag store joins a template's parts with `?` and caches the prepared statement by that
 * text, so a statement written with `?` placeholders, including one composed from shared column
 * lists and conditions, splits back into the parts that join to it.
 */
const toTemplate = (sql: string): TemplateStringsArray => {
  const parts = sql.split('?');
  return Object.assign(parts, { raw: parts });
};

/**
 * Prepares each of the worker's statements once, caching it by its text in SQLite's tag store.
 * Rows come from HQ's own tables, whose schema constrains them, so they are typed, not parsed.
 * @returns The connection's cached statement runner.
 */
export const createStatements = (database: DatabaseSync) => {
  const store = database.createTagStore(STATEMENT_CACHE_CAPACITY);
  return {
    get: <TRow>(sql: string, ...parameters: SQLInputValue[]): TRow | undefined =>
      store.get(toTemplate(sql), ...parameters) as TRow | undefined,
    all: <TRow>(sql: string, ...parameters: SQLInputValue[]): TRow[] =>
      store.all(toTemplate(sql), ...parameters) as TRow[],
    run: (sql: string, ...parameters: SQLInputValue[]) => store.run(toTemplate(sql), ...parameters),
  };
};
export type IStatements = ReturnType<typeof createStatements>;
