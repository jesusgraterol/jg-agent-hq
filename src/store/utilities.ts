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
