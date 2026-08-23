import rateLimit from "express-rate-limit";
import type { RateLimitRequestHandler } from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import type { AuthedRequest } from "../middleware/auth";
import { getRedisClient, isRedisReady } from "./redis";

export interface UserRateLimitOptions {
  windowMs: number;
  limit: number;
  message?: unknown;
  standardHeaders?: boolean;
  /** Prefixo da chave Redis se store estiver ativo (separar stores diferentes). */
  redisPrefix?: string;
}

function defaultMessage() {
  return {
    error: {
      code: "TOO_MANY_REQUESTS",
      message: "Demasiados pedidos em pouco tempo. Aguarde uns minutos e tente novamente.",
    },
  } as const;
}

export function userRateLimit(opts: UserRateLimitOptions): RateLimitRequestHandler {
  const redis = getRedisClient();
  const useRedisStore = !!redis && isRedisReady();

  const store = useRedisStore
    ? new RedisStore({
        sendCommand: async (...args: any[]) => {
          if (!redis) throw new Error("redis unavailable");
          return (redis as any).call(...args);
        },
        prefix: `bet62:rl:${opts.redisPrefix ?? "default"}:`,
      })
    : undefined;

  return rateLimit({
    windowMs: opts.windowMs,
    limit: opts.limit,
    standardHeaders: opts.standardHeaders ?? true,
    legacyHeaders: false,
    store,
    keyGenerator: (req) => {
      const authed = (req as AuthedRequest).user;
      if (authed?.id) return `user:${authed.id}`;
      return `ip:${req.ip ?? "unknown"}`;
    },
    message: opts.message ?? defaultMessage(),
  });
}
