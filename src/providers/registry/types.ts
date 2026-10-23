import type { IProviderId } from '../../contracts/index.js';
import type { INativeOutcome } from '../../store/control/index.js';
import type {
  IAgentProvider,
  IAgentProviderEvents,
  IProviderCall,
  IAgentProviderFactory,
  IProviderThread,
} from '../index.js';

// only runtime-owned registrations can preserve built-in exception contracts
export type IProviderRegistration = { factory: IAgentProviderFactory; isBuiltIn: boolean };

// runtime callers receive concrete operations with cancellation owned by the registry
export type IBoundAgentProvider = {
  [K in keyof IAgentProvider]: IAgentProvider[K] extends (...inputs: infer TInputs) => infer TResult
    ? TInputs extends [...infer TOperationInputs, IProviderCall]
      ? (...inputs: TOperationInputs) => TResult
      : IAgentProvider[K]
    : IAgentProvider[K];
};

// provider identity comes from registration, independently of native event payloads
export type IProviderRegistryEvents = {
  [K in keyof IAgentProviderEvents]: K extends 'outcome'
    ? (provider: IProviderId, outcome: INativeOutcome, thread?: IProviderThread) => void
    : (provider: IProviderId, ...inputs: Parameters<IAgentProviderEvents[K]>) => void;
};
