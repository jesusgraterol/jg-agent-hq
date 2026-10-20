// bounded destination and deployment checks
export {
  readDestination,
  verifyDeployment,
  verifyPublicDestinations,
} from './public-destinations.ts';
// external HTTP boundary
export type { IDestinationFetch, IDestinationResponse } from './types.ts';
