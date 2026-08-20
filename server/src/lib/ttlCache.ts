/**
 * Cache TTL genérica em memória — mesma ideia já usada em sports/prematch/service.ts e
 * sports/competitions/service.ts (Map + fetchedAt), extraída para reutilizar em qualquer sítio
 * que precise de aparar chamadas repetidas a uma API externa (ex: API-Football) sem inventar
 * dados nem esconder erros: numa falha do `fetcher`, a promise rejeita normalmente (nada fica
 * em cache), quem chamou decide o que fazer.
 *
 * Por processo, não partilhada entre instâncias — suficiente aqui porque cada valor cacheado
 * já é, por si só, o resultado de uma chamada de rede cara a evitar repetir, não um dado que
 * precise de estar sincronizado entre réplicas (essas continuam a bater na mesma API-Football
 * de qualquer forma, só que com menos frequência).
 */
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

/** Coalescing simples: pedidos concorrentes para a mesma chave partilham a mesma promise em
 * voo, em vez de disparar N chamadas idênticas à API externa em paralelo (ex: vários
 * utilizadores a abrir o mesmo evento ao mesmo tempo). */
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
