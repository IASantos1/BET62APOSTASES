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
    //
    // Futebol tem um catálogo MUITO maior que os outros 7 desportos (muito mais ligas/jogos em
    // simultâneo — ver docs/SPORTS_DATA.md, "cobertura de mercados muito maior" para futebol) e
    // a ordem dos eventos devolvida pela Pulsescore não é garantida por proximidade do início
    // (a própria doc já confirmou ordem arbitrária para mercados; o mesmo risco aplica-se aqui).
    // Com só 2 páginas (50 eventos) — suficiente para os outros desportos, cujo catálogo total é
    // muito menor — os poucos jogos "scheduled" de futebol podem simplesmente não caber nas
    // primeiras 50 entradas devolvidas, mostrando "sem jogos" mesmo havendo muitos agendados.
    // Prioridade explícita do utilizador é o futebol carregar bem — mais páginas só para ele.
    const maxPages = sport === "football" ? 8 : 2;
    const all = await fetchEventsFlat(sport, { maxPages });
    const scheduled = all.filter((e) => e.status === "scheduled");
    cache.set(cacheKey, { events: scheduled, fetchedAt: Date.now() });
    return { events: scheduled, source: "pulsescore" };
  } catch (err) {
    logger.warn({ err, sport }, "Pulsescore: falha ao obter pré-jogo, a cair para dados de demonstração");
    return { events: [], source: "unconfigured" };
  }
}
