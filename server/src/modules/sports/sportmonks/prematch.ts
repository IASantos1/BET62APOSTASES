import type { LiveEvent } from "../types";
import { fetchFixturesBetween, fetchLeaguesWithCurrentRound, getRoundEvents } from "./client";

/**
 * Junta o pré-jogo de futebol de TODAS as ligas da Sportmonks (pedido explícito do utilizador)
 * numa lista plana. Usa fetchFixturesBetween() (intervalo de datas, todas as ligas de uma vez) —
 * ver aviso "não confirmado" em sportmonks/client.ts. A via original, por "ronda atual" de cada
 * liga (fetchLeaguesWithCurrentRound), confirmou-se estruturalmente quebrada em produção (0 ligas
 * com ronda atual em 20 páginas percorridas, ver GET /api/sports/sportmonks-debug) — mantida no
 * módulo (getSportmonksFootballPrematchByRounds) só para referência/diagnóstico, já não é o
 * caminho principal.
 */
const CACHE_TTL_MS = 45_000; // mesmo TTL já usado para o pré-jogo da Pulsescore
const PREMATCH_WINDOW_DAYS = 5; // dias à frente a cobrir — reduzido de 10 para 5 (payload menor,
// mais rápido); sem confirmação do período ideal da Sportmonks, valor razoável, pode subir depois
// de confirmado que o endpoint responde bem.

// Amostra real em produção (198 jogos, 5 dias): média de ~150 mercados por jogo, alguns com 267 —
// muito mais do que a Pulsescore costuma trazer (até ~34 numa amostra rica) porque
// fetchFixturesBetween() não filtra por mercado (ver aviso "não confirmado" em client.ts sobre
// não adivinhar IDs de mercado). Isto sozinho gerava respostas de 8+ MB, lentas a transferir e a
// desenhar no telemóvel. Não é curadoria de "quais mercados importam" (isso exigiria adivinhar
// IDs/nomes não confirmados) — é só um limite de largura de banda para a LISTA de pré-jogo: fica
// com os primeiros N mercados devolvidos pela Sportmonks para cada jogo, que continuam a ser
// "vários mercados" (pedido explícito do utilizador), só não TODOS de uma vez.
const MAX_MARKETS_PER_EVENT_IN_LIST = 30;

let cache: { events: LiveEvent[]; fetchedAt: number } | null = null;

function dateRangeFromToday(days: number): { start: string; end: string } {
  const now = new Date();
  const start = now.toISOString().slice(0, 10);
  const end = new Date(now.getTime() + days * 86_400_000).toISOString().slice(0, 10);
  return { start, end };
}

async function fetchAndNormalize(): Promise<LiveEvent[]> {
  const { start, end } = dateRangeFromToday(PREMATCH_WINDOW_DAYS);
  const events = await fetchFixturesBetween(start, end);
  return events
    .filter((e) => e.status === "scheduled")
    // Jogos sem odds do bookmaker filtrado (bet365) não são utilizáveis para apostar — mostrá-los
    // na lista era o "jogos sem odds" reportado pelo utilizador. Excluídos aqui, não em
    // normalizeFixture(), para o diagnóstico (getSportmonksFootballPrematchDiagnosis) continuar a
    // ver a contagem bruta e conseguir distinguir "0 jogos" de "jogos sem odds".
    .filter((e) => e.odds.length > 0)
    .map((e) => (e.odds.length > MAX_MARKETS_PER_EVENT_IN_LIST ? { ...e, odds: e.odds.slice(0, MAX_MARKETS_PER_EVENT_IN_LIST) } : e));
}

export async function getSportmonksFootballPrematch(): Promise<LiveEvent[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.events;
  const events = await fetchAndNormalize();
  cache = { events, fetchedAt: Date.now() };
  return events;
}

// Pré-aquece a cache em segundo plano em vez de deixar o primeiro pedido do utilizador depois de
// cada expiração (45s) esperar pela cadeia inteira de pedidos à Sportmonks (até 8 páginas em
// série, cada uma com todos os mercados de todas as ligas no intervalo) — isso é que fazia o
// "carregamento a demorar muito" reportado: um utilizador ao calhar era quem pagava esse custo em
// direto. Com isto, só o primeiro pedido a seguir ao arranque do servidor espera; todos os outros
// recebem sempre a cache já pronta. Uma falha aqui é só registada — a próxima chamada real de
// getSportmonksFootballPrematch() tenta de novo (mesmo comportamento de antes desta otimização).
const BACKGROUND_REFRESH_MS = 40_000; // < CACHE_TTL_MS, para nunca deixar a cache expirar em uso
export function startSportmonksPrematchBackgroundRefresh(): void {
  const tick = () =>
    fetchAndNormalize()
      .then((events) => {
        cache = { events, fetchedAt: Date.now() };
      })
      .catch(() => {
        /* mantém a cache anterior (ou nenhuma) — a próxima chamada real tenta de novo */
      });
  void tick();
  setInterval(tick, BACKGROUND_REFRESH_MS);
}

/** Diagnóstico (ver routes.ts, GET /api/sports/sportmonks-debug) — janela pequena (2 dias) e só 2
 * páginas: o objetivo aqui é só provar rapidamente que /fixtures/between responde mesmo, não
 * obter a lista completa (isso é o que getSportmonksFootballPrematch() faz, com mais margem). Um
 * pedido sem limite nenhum foi o que ficou preso "só a carregar" em produção. */
export async function getSportmonksFootballPrematchDiagnosis(): Promise<{
  dateRange: { start: string; end: string };
  totalFixturesFound: number;
  scheduledFixtures: number;
  sampleFixture: LiveEvent | null;
  diagnosis: string;
}> {
  const { start, end } = dateRangeFromToday(2);
  const events = await fetchFixturesBetween(start, end, { maxPages: 2 });
  const scheduled = events.filter((e) => e.status === "scheduled");

  let diagnosis: string;
  if (events.length === 0) {
    diagnosis = `0 jogos encontrados entre ${start} e ${end} (só as 2 primeiras páginas, para ser rápido) — verificar se /fixtures/between existe mesmo no plano da conta (endpoint não confirmado por amostra real).`;
  } else if (scheduled.length === 0) {
    diagnosis = `${events.length} jogos encontrados, mas nenhum com status "scheduled" (todos já começaram/terminaram) — sinal de possível problema na classificação de status.`;
  } else {
    diagnosis = `${scheduled.length} jogos agendados encontrados (amostra de 2 páginas/2 dias) — a funcionar.`;
  }

  return { dateRange: { start, end }, totalFixturesFound: events.length, scheduledFixtures: scheduled.length, sampleFixture: events[0] ?? null, diagnosis };
}

// --- Mantido só para referência/diagnóstico — via "ronda atual" confirmada quebrada, ver aviso acima ---

const LEAGUES_CACHE_TTL_MS = 60 * 60_000;
let leaguesCache: { pairs: Array<{ leagueId: number; roundId: number }>; fetchedAt: number } | null = null;

async function getLeaguesWithCurrentRoundCached(): Promise<Array<{ leagueId: number; roundId: number }>> {
  if (leaguesCache && Date.now() - leaguesCache.fetchedAt < LEAGUES_CACHE_TTL_MS) return leaguesCache.pairs;
  const pairs = await fetchLeaguesWithCurrentRound();
  leaguesCache = { pairs, fetchedAt: Date.now() };
  return pairs;
}

export async function getSportmonksFootballPrematchByRounds(): Promise<LiveEvent[]> {
  const pairs = await getLeaguesWithCurrentRoundCached();
  const results = await Promise.allSettled(pairs.map(({ roundId }) => getRoundEvents(roundId)));
  const events: LiveEvent[] = [];
  results.forEach((r) => {
    if (r.status === "fulfilled") events.push(...r.value.filter((e) => e.status === "scheduled"));
  });
  return events;
}
