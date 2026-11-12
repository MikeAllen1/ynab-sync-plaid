import { SyncLock } from "../src/lock/sync-lock-do";

/** In-memory Durable Object namespace with the same fetch contract as Cloudflare. */
export function makeTestSyncLock(initial: Record<string, unknown> = {}): DurableObjectNamespace {
  const data = new Map<string, unknown>(Object.entries(initial));
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
    idFromName: (name: string) => name as unknown as DurableObjectId,
    get: () => ({
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        return durableObject.fetch(request);
      }
    })
  } as unknown as DurableObjectNamespace;
}
