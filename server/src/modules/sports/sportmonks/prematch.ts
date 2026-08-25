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
let cache: { events: LiveEvent[]; fetchedAt: number } | null = null;

function dateRangeFromToday(days: number): { start: string; end: string } {
  const now = new Date();
  const start = now.toISOString().slice(0, 10);
  const end = new Date(now.getTime() + days * 86_400_000).toISOString().slice(0, 10);
  return { start, end };
}

export async function getSportmonksFootballPrematch(): Promise<LiveEvent[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.events;

  const { start, end } = dateRangeFromToday(PREMATCH_WINDOW_DAYS);
  const events = await fetchFixturesBetween(start, end);
  const scheduled = events.filter((e) => e.status === "scheduled");
  cache = { events: scheduled, fetchedAt: Date.now() };
  return scheduled;
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
