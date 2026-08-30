import type { LiveEvent } from "../types";
import { fetchFixturesBetween, fetchLeaguesWithCurrentRound, getRoundEvents } from "./client";
import { hybridSportsService } from "../hybridService";
import { env } from "../../../config/env";

/**
 * Pré-jogo de futebol via Sportmonks — reescrito do zero (2026-08-27). Junta o pré-jogo de
 * TODAS as ligas numa lista plana via GET /fixtures/between (intervalo de datas), em cache curta
 * pré-aquecida em segundo plano para nenhum utilizador pagar o custo da cadeia de pedidos em
 * direto.
 */
const CACHE_TTL_MS = 45_000;
const PREMATCH_WINDOW_DAYS = 5;
const BACKGROUND_REFRESH_MS = 40_000; // < CACHE_TTL_MS, para a cache nunca expirar em uso

let cache: { events: LiveEvent[]; fetchedAt: number } | null = null;

function dateRangeFromToday(days: number): { start: string; end: string } {
  const now = new Date();
  const start = now.toISOString().slice(0, 10);
  const end = new Date(now.getTime() + days * 86_400_000).toISOString().slice(0, 10);
  return { start, end };
}

// Publica os "scheduled" no mesmo snapshot do hybridSportsService (sport "football"), para
// hybridSportsService.snapshot("football")/getById()/GET /api/sports/events também os incluírem.
// O poller Ao Vivo (live.ts, snapshot completo a cada 12s) também publica em "football" e não
// traz scheduled — mas REMOVE_GRACE_MS (90s, hybridService.ts) > BACKGROUND_REFRESH_MS (40s), por
// isso este tick renova sempre os scheduled antes da margem expirar.
function syncScheduledToHybrid(events: LiveEvent[]) {
  if (!env.SPORTMONKS_API_KEY || env.FOOTBALL_PROVIDER !== "sportmonks") return;
  const scheduled = events.filter((e) => e.status === "scheduled");
  try {
    hybridSportsService.applyExternalSnapshot("football", scheduled);
  } catch {
    /* falha de sync não bloqueia a cache nem a resposta ao utilizador */
  }
}

async function fetchAndNormalize(): Promise<LiveEvent[]> {
  const { start, end } = dateRangeFromToday(PREMATCH_WINDOW_DAYS);
  const events = await fetchFixturesBetween(start, end);
  // Jogos sem odds do bookmaker filtrado não são utilizáveis para apostar. Mantém tanto
  // "scheduled" como "live" (normalizeFixture chama "live" a qualquer jogo já começado) — esta
  // cache alimenta o pré-jogo (só scheduled, filtrado abaixo) E o poller Ao Vivo (live.ts), que
  // procura aqui as odds de um jogo que acabou de passar de scheduled.
  const withOdds = events.filter((e) => e.odds.length > 0);
  syncScheduledToHybrid(withOdds);
  return withOdds;
}

// startTime é sempre ISO UTC explícito (ver normalizeFixture em client.ts); os primeiros 10
// caracteres já são o dia civil "YYYY-MM-DD" nesse fuso — usado só para agrupar/filtrar por dia.
function eventDateKey(e: LiveEvent): string {
  return (e.startTime ?? "").slice(0, 10);
}

export interface SportmonksPrematchResult {
  events: LiveEvent[];
  /** Todos os dias com pelo menos um jogo na janela cheia, ordenados — usado pelo frontend para
   * os separadores de dia. `events` é só o dia pedido (ou o primeiro disponível, por omissão). */
  availableDates: string[];
}

/**
 * Devolve TODOS os mercados de cada jogo (nunca cortados), mas só os jogos de UM dia por vez —
 * mandar a janela inteira (~200 jogos/5 dias) com todos os mercados de cada gerava respostas de
 * vários MB. A janela cheia fica em cache (getSportmonksEventById também procura nela); só a
 * resposta é fatiada por dia.
 */
export async function getSportmonksFootballPrematch(date?: string): Promise<SportmonksPrematchResult> {
  if (!cache || Date.now() - cache.fetchedAt >= CACHE_TTL_MS) {
    cache = { events: await fetchAndNormalize(), fetchedAt: Date.now() };
  }
  // Só "scheduled" aqui — os jogos já começados também ficam na cache (fetchAndNormalize), mas
  // esses já aparecem no Ao Vivo (sportmonks/live.ts).
  const allEvents = cache.events.filter((e) => e.status === "scheduled");
  const availableDates = [...new Set(allEvents.map(eventDateKey))].sort();
  const targetDate = date && availableDates.includes(date) ? date : availableDates[0];
  const events = targetDate ? allEvents.filter((e) => eventDateKey(e) === targetDate) : [];
  return { events, availableDates };
}

/** Procura um jogo pelo id (`sportmonks:<fixtureId>`) na janela cheia já em cache — usado por
 * H2H/previsões/classificação (routes.ts). Não dispara um pedido novo; devolve null se a cache
 * ainda não tiver sido preenchida, em vez de bloquear o pedido do utilizador. */
export function getSportmonksEventById(id: string): LiveEvent | null {
  return cache?.events.find((e) => e.id === id) ?? null;
}

/** Pré-aquece a cache em segundo plano — sem isto, o primeiro pedido a seguir a cada expiração
 * (45s) esperava pela cadeia inteira de pedidos à Sportmonks (até 8 páginas em série). */
export function startSportmonksPrematchBackgroundRefresh(): void {
  const tick = () =>
    fetchAndNormalize()
      .then((events) => {
        cache = { events, fetchedAt: Date.now() };
        syncScheduledToHybrid(events);
      })
      .catch(() => {
        /* mantém a cache anterior — a próxima chamada real tenta de novo */
      });
  void tick();
  setInterval(tick, BACKGROUND_REFRESH_MS);
}

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
    diagnosis = `0 jogos encontrados entre ${start} e ${end} (só as 2 primeiras páginas) — verificar se /fixtures/between existe no plano da conta.`;
  } else if (scheduled.length === 0) {
    diagnosis = `${events.length} jogos encontrados, mas nenhum "scheduled" (todos já começaram/terminaram) — possível problema na classificação de status.`;
  } else {
    diagnosis = `${scheduled.length} jogos agendados encontrados (amostra de 2 páginas/2 dias) — a funcionar.`;
  }

  return { dateRange: { start, end }, totalFixturesFound: events.length, scheduledFixtures: scheduled.length, sampleFixture: events[0] ?? null, diagnosis };
}

// --- Mantido só para diagnóstico — via "ronda atual" já confirmada estruturalmente quebrada em
// produção (0 ligas com ronda atual encontradas em amostra real), fetchFixturesBetween acima é o
// caminho principal.

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
