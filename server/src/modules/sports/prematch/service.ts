import { env } from "../../../config/env";
import { logger } from "../../../lib/logger";
import { fetchEventsFlat } from "../pulsescore/client";
import { getSportmonksFootballPrematch } from "../sportmonks/prematch";
import type { LiveEvent, Sport } from "../types";

const CACHE_TTL_MS = 15_000;
const cache = new Map<string, { events: LiveEvent[]; fetchedAt: number }>();

export interface PrematchResult {
  events: LiveEvent[];
  source: "pulsescore" | "sportmonks" | "unconfigured";
  /** Só para futebol+Sportmonks (pedido explícito do utilizador): outros dias com jogos na janela
   * cheia (~200 jogos/5 dias), para o frontend desenhar separadores de dia. `events` é sempre só
   * o dia pedido (`date`) ou o primeiro disponível. */
  availableDates?: string[];
}

/**
 * Pré-jogo real via Pulsescore (só eventos `live:false`), com cache curto em memória para não
 * disparar um pedido novo por cada utilizador que abrir a página Esportes ao mesmo tempo.
 * Sem PULSESCORE_API_KEY configurada, ou se o pedido falhar (provedor em baixo, rede bloqueada,
 * chave inválida), devolve `source: "unconfigured"` com lista vazia — o frontend usa isso para
 * saber que deve cair para os dados de demonstração estáticos, tal como acontece no feed ao vivo.
 *
 * FOOTBALL_PROVIDER=sportmonks (env.ts, pedido explícito do utilizador): só o futebol desvia
 * para a Sportmonks aqui — os outros 7 desportos nunca tocam neste ramo, ficam sempre na
 * Pulsescore como antes. O Ao Vivo de futebol (hybridService.ts) NÃO foi alterado — continua na
 * Pulsescore, porque a amostra da Sportmonks confirmada até agora só cobre pré-jogo com odds
 * (o endpoint ao vivo que o utilizador mostrou primeiro, livescores/inplay, não tinha odds
 * nenhumas — ver conversa). Misturar as duas fontes (pré-jogo Sportmonks + ao vivo Pulsescore)
 * é deliberado e temporário, não um esquecimento — trocar o ao vivo precisa de uma amostra real
 * confirmada com odds antes de avançar, mesma disciplina usada em todo este projeto.
 */
export async function getPrematchEvents(sport: Sport, date?: string): Promise<PrematchResult> {
  if (sport === "football" && env.FOOTBALL_PROVIDER === "sportmonks") {
    if (!env.SPORTMONKS_API_KEY) return { events: [], source: "unconfigured" };
    // Sem cache extra aqui de propósito: getSportmonksFootballPrematch() já tem a sua própria
    // cache de 45s pré-aquecida em segundo plano (ver sportmonks/prematch.ts) — fatiar por dia é
    // só um filtro em memória sobre essa cache, não vale a pena outra camada por cima.
    try {
      const { events, availableDates } = await getSportmonksFootballPrematch(date);
      return { events, source: "sportmonks", availableDates };
    } catch (err) {
      logger.warn({ err }, "Sportmonks: falha ao obter pré-jogo de futebol");
      return { events: [], source: "unconfigured" };
    }
  }

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
