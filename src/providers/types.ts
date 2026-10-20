import type {
  IActionCommand,
  IManagedThread,
  INativeApproval,
  ISkill,
} from '../contracts/index.js';

// owned native process transport; adapters own all provider protocol semantics
export type IProviderProcess = {
  readonly isRunning: boolean;
  write(message: unknown): Promise<void>;
  close(): Promise<void>;
};

// a native request owns its validation and exact response channel; bodies remain in memory
export type INativePrompt = {
  provider: IManagedThread['provider'];
  nativeThreadId: string;
  nativeTurnId: string;
  requestId: string;
  fingerprint: string;
  presentation: Pick<
    INativeApproval,
    'kind' | 'title' | 'detail' | 'decisions' | 'questions' | 'isBlocking'
  >;
  /**
   * Validates a reply against the exact displayed native request.
   * @returns The native response payload without widening the requested scope.
   * @throws
   * - -1: The HQ request is invalid
   */
  validate(response: Extract<IActionCommand, { kind: 'native-reply' }>['response']): unknown;
  /**
   * Writes this request's response on its owning native channel.
   * @returns Confirmation of the write, which does not prove native consumption.
   * @throws
   * - -1: The HQ transport failed
   */
  reply(response: unknown): Promise<void>;
  /**
   * Denies this request without granting any native permission.
   * @returns Confirmation that the denial was written.
   * @throws
   * - -1: The HQ transport failed
   */
  reject(): Promise<void>;
};

// normalized native inventory, bounded before client paging
export type IProviderSkills = {
  skills: Omit<ISkill, 'id'>[];
  unavailableCount: number;
  observedAt: number;
};
