import { createKvTtlCache, type KvTtlCache } from "./redis";

export class TtlCache<V> {
  private store = new Map<string, { value: V; expiresAt: number }>();

  constructor(private readonly ttlMs: number) {}

  get(key: string): V | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (Date.now() > hit.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V): void {
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }
}

export function cached<V>(cache: TtlCache<V>, inFlight: Map<string, Promise<V>>, key: string, fetcher: () => Promise<V>): Promise<V> {
  const hit = cache.get(key);
  if (hit !== undefined) return Promise.resolve(hit);

  const pending = inFlight.get(key);
  if (pending) return pending;

  const promise = fetcher()
    .then((value) => {
      cache.set(key, value);
      inFlight.delete(key);
      return value;
    })
    .catch((err) => {
      inFlight.delete(key);
      throw err;
    });
  inFlight.set(key, promise);
  return promise;
}

/** Cache TTL PARTILHADO entre réplicas Railway via Redis (com fallback em mem se Redis
 * indisponível). Assíncrono por causa do Redis; usem-no em services que já são async. */
export class SharedTtlCache<V> implements KvTtlCache<V> {
  private readonly backend: KvTtlCache<V>;
  private readonly fallback: TtlCache<V>;
  private readonly ttlMs: number;

  constructor(namespace: string, ttlMs: number) {
    this.ttlMs = ttlMs;
    this.backend = createKvTtlCache<V>(namespace);
    this.fallback = new TtlCache<V>(this.ttlMs);
  }

  async get(key: string): Promise<V | undefined> {
    try {
      const shared = await this.backend.get(key);
      if (shared !== undefined) return shared;
    } catch {
      /* continua para fallback mem abaixo */
    }
    return this.fallback.get(key);
  }

  async set(key: string, value: V): Promise<void> {
    try {
      await this.backend.set(key, value, this.ttlMs);
    } catch {
      /* ignora: fallback mem abaixo guarda sempre */
    }
    this.fallback.set(key, value);
  }
}

export async function sharedCached<V>(
  cache: SharedTtlCache<V>,
  inFlight: Map<string, Promise<V>>,
  key: string,
  fetcher: () => Promise<V>
): Promise<V> {
  const hit = await cache.get(key);
  if (hit !== undefined) return hit;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const promise = fetcher()
    .then(async (value) => {
      await cache.set(key, value);
      inFlight.delete(key);
      return value;
    })
    .catch((err) => {
      inFlight.delete(key);
      throw err;
    });
  inFlight.set(key, promise);
  return promise;
}
