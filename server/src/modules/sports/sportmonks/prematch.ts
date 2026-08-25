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

async function fetchAndNormalize(): Promise<LiveEvent[]> {
  const { start, end } = dateRangeFromToday(PREMATCH_WINDOW_DAYS);
  const events = await fetchFixturesBetween(start, end);
  return (
    events
      .filter((e) => e.status === "scheduled")
      // Jogos sem odds do bookmaker filtrado (bet365) não são utilizáveis para apostar — mostrá-los
      // na lista era o "jogos sem odds" reportado pelo utilizador.
      .filter((e) => e.odds.length > 0)
  );
}

/** startTime é sempre ISO UTC explícito (ver normalizeFixture em client.ts) — os primeiros 10
 * caracteres já são o dia civil "YYYY-MM-DD" nesse fuso, usado só para agrupar/filtrar por dia
 * (não é o dia civil do utilizador, mas é estável e consistente com o resto do pipeline). */
function eventDateKey(e: LiveEvent): string {
  // startTime é sempre preenchido pelo normalizeFixture() da Sportmonks (ver client.ts) — o tipo
  // é opcional só porque LiveEvent é partilhado com o feed ao vivo da Pulsescore, que não o tem.
  return (e.startTime ?? "").slice(0, 10);
}

export interface SportmonksPrematchResult {
  events: LiveEvent[];
  /** Todos os dias com pelo menos um jogo na janela cheia (~200 jogos/5 dias), ordenados — usado
   * pelo frontend para desenhar os separadores de dia. `events` é só o dia pedido (ou o primeiro
   * disponível, por omissão). */
  availableDates: string[];
}

/**
 * Pedido explícito do utilizador: manter TODOS os mercados de cada jogo (não cortar), mas limitar
 * quantos JOGOS ficam visíveis de uma vez — em vez de mandar os ~200 jogos da janela toda com
 * todos os mercados (era isso que gerava as respostas de 8+ MB, lentas), devolve só os jogos de UM
 * dia (`date`, ou o primeiro dia disponível por omissão — tipicamente ~40 jogos/dia numa amostra
 * real de 198 jogos/5 dias), com a lista de dias disponíveis para o frontend deixar trocar de dia.
 * A janela cheia continua toda em cache (getSportmonksEventById também procura nela), só a resposta
 * é que fica fatiada por dia.
 */
export async function getSportmonksFootballPrematch(date?: string): Promise<SportmonksPrematchResult> {
  if (!cache || Date.now() - cache.fetchedAt >= CACHE_TTL_MS) {
    cache = { events: await fetchAndNormalize(), fetchedAt: Date.now() };
  }
  const allEvents = cache.events;
  const availableDates = [...new Set(allEvents.map(eventDateKey))].sort();
  const targetDate = date && availableDates.includes(date) ? date : availableDates[0];
  const events = targetDate ? allEvents.filter((e) => eventDateKey(e) === targetDate) : [];
  return { events, availableDates };
}

/** Procura um jogo pelo id (`sportmonks:<fixtureId>`) na janela cheia já em cache — usado pelas
 * rotas de H2H/previsões/classificação (routes.ts), que só sabiam procurar eventos na cache da
 * Pulsescore (hybridSportsService.getById) e por isso devolviam sempre vazio para jogos da
 * Sportmonks. Não dispara um pedido novo à Sportmonks: se a cache ainda não tiver sido preenchida
 * (ex: mesmo depois do arranque do servidor, antes do primeiro tick do pré-aquecimento em
 * segundo plano), devolve null em vez de bloquear o pedido do utilizador. */
export function getSportmonksEventById(id: string): LiveEvent | null {
  return cache?.events.find((e) => e.id === id) ?? null;
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
