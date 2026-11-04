// a request awaiting its response, settled once by its response, its deadline or a failure
type IPendingRequest = {
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
};

/**
 * Tracks the requests sent over one connection until each one's response, matched by its ID,
 * settles it. A response that arrives after its request's deadline finds nothing pending.
 * @returns The connection's pending requests.
 */
export const createPendingRequests = <TId>() => {
  const requests = new Map<TId, IPendingRequest>();
  const take = (id: TId): IPendingRequest | undefined => {
    const request = requests.get(id);
    if (!request) return undefined;
    requests.delete(id);
    clearTimeout(request.timer);
    return request;
  };
  return {
    get size(): number {
      return requests.size;
    },
    has: (id: TId): boolean => requests.has(id),
    /**
     * Registers a request before it is sent.
     * @param id The request's ID, which no pending request has.
     * @param timeoutMs How long its response may take, or undefined for no deadline.
     * @param onTimeout Builds the error a request rejects with once its deadline passed, after it
     * stopped being pending.
     * @returns A promise that settles with the request's response or failure.
     */
    add: (id: TId, timeoutMs: number | undefined, onTimeout: () => unknown): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const timer =
          timeoutMs === undefined
            ? undefined
            : setTimeout(() => {
                requests.delete(id);
                reject(onTimeout());
              }, timeoutMs);
        requests.set(id, { resolve, reject, timer });
      }),
    /**
     * Settles a pending request with its response.
     * @returns Whether the request was pending; a late or unknown response's isn't.
     */
    resolve: (id: TId, result: unknown): boolean => {
      const request = take(id);
      request?.resolve(result);
      return request !== undefined;
    },
    /**
     * Fails a pending request, such as with its native rejection.
     * @returns Whether the request was pending; a late or unknown response's isn't.
     */
    reject: (id: TId, error: unknown): boolean => {
      const request = take(id);
      request?.reject(error);
      return request !== undefined;
    },
    /** Fails every pending request, such as when the connection fails. */
    rejectAll: (error: unknown): void => {
      for (const id of [...requests.keys()]) take(id)?.reject(error);
    },
  };
};
