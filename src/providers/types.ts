// owned native process transport; adapters own all provider protocol semantics
export type IProviderProcess = {
  readonly isRunning: boolean;
  write(message: unknown): Promise<void>;
  close(): Promise<void>;
};
