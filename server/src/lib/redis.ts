import Redis from "ioredis";
import { env, isProd } from "../config/env";
import { logger } from "./logger";

let clientInstance: Redis | null = null;
let clientReady = false;

export function getRedisClient(): Redis | null {
  if (!env.REDIS_URL) return null;
  if (clientInstance) return clientInstance;
  try {
    clientInstance = new Redis(env.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      showFriendlyErrorStack: !isProd,
    });
    clientInstance.on("error", (err) => {
      logger.warn({ err: String(err).slice(0, 200) }, "[REDIS] erro de ligação; a manter fallback em memória para o que for possível");
      clientReady = false;
    });
    clientInstance.on("ready", () => {
      clientReady = true;
      logger.info("[REDIS] cliente ligado com sucesso");
    });
    clientInstance.connect().catch((err) => {
      logger.warn({ err: String(err).slice(0, 200) }, "[REDIS] falhou conexão inicial; modo memória local ativo");
      clientReady = false;
    });
    return clientInstance;
  } catch (err) {
    logger.warn({ err: String(err).slice(0, 200) }, "[REDIS] falhou criar cliente; modo memória local");
    clientInstance = null;
    return null;
  }
}

export function isRedisReady(): boolean {
  return clientReady && !!clientInstance;
}

export function createRedisDuplicateClient(): Redis | null {
  const base = getRedisClient();
  if (!base || !env.REDIS_URL) return null;
  try {
    return base.duplicate({ lazyConnect: true });
  } catch {
    return null;
  }
}

export async function acquireDistributedLock(key: string, ttlMs: number): Promise<boolean> {
  const r = getRedisClient();
  if (!r || !isRedisReady()) {
    // Sem Redis = consideramo-nos "líder" sempre. Se houver N>1 réplicas sem Redis, cada uma
    // abre suas conexões Pulsescore (risco de ultrapassar o plano, mas há fallback REST/polling).
    return true;
  }
  const res = await r.set(key, "1", "PX", ttlMs, "NX");
  return res === "OK";
}

export async function refreshDistributedLock(key: string, ttlMs: number): Promise<boolean> {
  const r = getRedisClient();
  if (!r || !isRedisReady()) return true;
  const res = await r.expire(key, Math.ceil(ttlMs / 1000));
  return res === 1;
}

// ---------- TTL cache (compatível com Map em mem fallback) ----------
export interface KvTtlCache<V> {
  get(key: string): Promise<V | undefined>;
  set(key: string, value: V, ttlMs: number): Promise<void>;
}

export function createKvTtlCache<V>(namespace: string): KvTtlCache<V> {
  const memory = new Map<string, { value: V; expiresAt: number }>();
  const fullKey = (k: string) => `bet62:cache:${namespace}:${k}`;
  return {
    async get(key: string) {
      const r = getRedisClient();
      if (r && isRedisReady()) {
        try {
          const raw = await r.get(fullKey(key));
          if (raw == null) return undefined;
          return JSON.parse(raw) as V;
        } catch (err) {
          logger.warn({ err: String(err).slice(0, 200), key }, "[REDIS] falhou GET cache, a tentar memória");
        }
      }
      const hit = memory.get(key);
      if (!hit) return undefined;
      if (Date.now() > hit.expiresAt) {
        memory.delete(key);
        return undefined;
      }
      return hit.value;
    },
    async set(key: string, value: V, ttlMs: number) {
      const r = getRedisClient();
      if (r && isRedisReady()) {
        try {
          await r.set(fullKey(key), JSON.stringify(value), "PX", ttlMs);
        } catch {
          /* ignora erro redis: cai para mem abaixo */
        }
      }
      memory.set(key, { value, expiresAt: Date.now() + ttlMs });
    },
  };
}
