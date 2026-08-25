import { logger } from "../../../lib/logger";
import type { LiveEvent } from "../types";
import { fetchLeaguesWithCurrentRound, getRoundEvents } from "./client";

/**
 * Junta o pré-jogo de futebol de TODAS as ligas da Sportmonks (pedido explícito do utilizador)
 * numa lista plana, ao contrário da API deles (organizada por ronda de uma liga de cada vez —
 * ver comentário em sportmonks/client.ts). Dois níveis de cache diferentes:
 * - Quais ligas existem e qual a sua ronda atual: muda raramente (uma ronda dura vários dias),
 *   cache de 1h — pedir isto a cada 45s desperdiçaria pedidos à toa.
 * - Os jogos+odds de CADA ronda: cache de 45s (ver getRoundEvents em client.ts), porque as odds
 *   em si mudam com frequência normal de pré-jogo.
 * "Todas as ligas" pode ser uma lista grande — os pedidos por ronda correm em paralelo
 * (Promise.allSettled), uma liga a falhar nunca derruba as restantes.
 */
const LEAGUES_CACHE_TTL_MS = 60 * 60_000;
let leaguesCache: { pairs: Array<{ leagueId: number; roundId: number }>; fetchedAt: number } | null = null;

async function getLeaguesWithCurrentRoundCached(): Promise<Array<{ leagueId: number; roundId: number }>> {
  if (leaguesCache && Date.now() - leaguesCache.fetchedAt < LEAGUES_CACHE_TTL_MS) return leaguesCache.pairs;
  const pairs = await fetchLeaguesWithCurrentRound();
  leaguesCache = { pairs, fetchedAt: Date.now() };
  return pairs;
}

export async function getSportmonksFootballPrematch(): Promise<LiveEvent[]> {
  const pairs = await getLeaguesWithCurrentRoundCached();
  const results = await Promise.allSettled(pairs.map(({ roundId }) => getRoundEvents(roundId)));

  const events: LiveEvent[] = [];
  let failures = 0;
  results.forEach((r, i) => {
    if (r.status === "fulfilled") events.push(...r.value.filter((e) => e.status === "scheduled"));
    else {
      failures += 1;
      logger.warn({ err: r.reason, roundId: pairs[i]?.roundId }, "Sportmonks: falha ao obter jogos desta ronda, a ignorar só esta");
    }
  });
  if (failures > 0) logger.warn({ failures, total: pairs.length }, "Sportmonks: algumas rondas falharam neste ciclo");

  return events;
}
