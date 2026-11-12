import { SyncLock } from "../../src/lock/sync-lock-do";

/** In-memory Durable Object namespace with serialized storage transactions. */
export function makeSyncLockNamespace(seed: Record<string, unknown> = {}) {
  const values = new Map<string, unknown>(Object.entries(seed));
  let tail: Promise<void> = Promise.resolve();
  const storage: any = {
    get: async (key: string) => values.get(key),
    put: async (key: string, value: unknown) => { values.set(key, value); },
    delete: async (key: string) => values.delete(key),
    list: async ({ prefix = "" }: any = {}) => new Map([...values].filter(([key]) => key.startsWith(prefix))),
    transaction: async (fn: (txn: any) => Promise<any>) => {
      let release!: () => void;
      const previous = tail;
      tail = new Promise<void>(resolve => { release = resolve; });
      await previous;
      try {
        return await fn({
          get: async (key: string) => values.get(key),
          put: async (key: string, value: unknown) => { values.set(key, value); },
          delete: async (key: string) => values.delete(key),
          list: async ({ prefix = "" }: any = {}) => new Map([...values].filter(([key]) => key.startsWith(prefix))),
        });
      } finally { release(); }
    }
  };
  const durableObject = new SyncLock({ storage } as any);
  return {
    idFromName: (name: string) => name,
    get: (_id: unknown) => ({
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        durableObject.fetch(new Request(input, init))
    })
  } as any;
}
