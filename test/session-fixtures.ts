import { SyncLock } from "../src/lock/sync-lock-do";

export function makeTestSyncLock(options: { failAcquire?: boolean } = {}): DurableObjectNamespace {
  const data = new Map<string, unknown>();
  const storage = {
    get: async (key: string) => data.get(key),
    put: async (key: string, value: unknown) => { data.set(key, value); },
    delete: async (key: string) => data.delete(key),
    transaction: async (fn: (txn: any) => Promise<any>) => fn({
      get: async (key: string) => data.get(key),
      put: async (key: string, value: unknown) => { data.set(key, value); },
      delete: async (key: string) => data.delete(key)
    })
  };
  const durableObject = new SyncLock({ storage } as unknown as DurableObjectState);
  return {
    idFromName: () => "test-global" as unknown as DurableObjectId,
    get: () => ({
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        if (options.failAcquire && new URL(request.url).pathname === "/acquire") {
          throw new Error("simulated unavailable lock");
        }
        return durableObject.fetch(request);
      }
    })
  } as unknown as DurableObjectNamespace;
}
