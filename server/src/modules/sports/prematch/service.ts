import { env } from "../../../config/env";
import { logger } from "../../../lib/logger";
import { fetchEventsFlat } from "../pulsescore/client";
import type { LiveEvent, Sport } from "../types";

const CACHE_TTL_MS = 45_000;
const cache = new Map<string, { events: LiveEvent[]; fetchedAt: number }>();

export interface PrematchResult {
  events: LiveEvent[];
  source: "pulsescore" | "unconfigured";
}

/**
 * Pré-jogo real via Pulsescore (só eventos `live:false`), com cache curto em memória para não
 * disparar um pedido novo por cada utilizador que abrir a página Esportes ao mesmo tempo.
 * Sem PULSESCORE_API_KEY configurada, ou se o pedido falhar (provedor em baixo, rede bloqueada,
 * chave inválida), devolve `source: "unconfigured"` com lista vazia — o frontend usa isso para
 * saber que deve cair para os dados de demonstração estáticos, tal como acontece no feed ao vivo.
 */
export async function getPrematchEvents(sport: Sport): Promise<PrematchResult> {
  if (!env.PULSESCORE_API_KEY) {
    return { events: [], source: "unconfigured" };
  }

  const cacheKey = sport;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return { events: cached.events, source: "pulsescore" };
  }

  try {
    // Usa /events (fetchEventsFlat), não /leagues (fetchEvents): todas as amostras reais que o
    // utilizador foi enviando (futebol, beisebol, voleibol, MMA, hóquei de gelo, ténis,
    // basquete) vieram de /events e são consistentemente ricas em mercados (até ~30 por jogo);
    // /leagues nunca foi confirmado com a mesma riqueza, apesar de ter a mesma forma de dados.
    const all = await fetchEventsFlat(sport, { maxPages: 2 });
    const scheduled = all.filter((e) => e.status === "scheduled");
    cache.set(cacheKey, { events: scheduled, fetchedAt: Date.now() });
    return { events: scheduled, source: "pulsescore" };
  } catch (err) {
    logger.warn({ err, sport }, "Pulsescore: falha ao obter pré-jogo, a cair para dados de demonstração");
    return { events: [], source: "unconfigured" };
  }
}
