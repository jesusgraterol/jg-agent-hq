// the external HTTP boundary, replaced only by an owned HTTP server in tests
export type IDestinationFetch = (url: string, init: RequestInit) => Promise<Response>;

// bounded decoded response and the media type used by deployment checks
export type IDestinationResponse = { body: string; contentType: string };
