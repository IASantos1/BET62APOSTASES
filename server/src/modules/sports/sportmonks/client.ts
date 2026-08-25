import { env } from "../../../config/env";
import { Errors } from "../../../lib/errors";
import { logger } from "../../../lib/logger";
import type { LiveEvent, LiveOdds, LiveSelection } from "../types";

/**
 * Sportmonks (v3.sportmonks.com/football) — substituto opcional da Pulsescore + API-Football só
 * para futebol (pedido explícito do utilizador; os outros 7 desportos ficam sempre na
 * Pulsescore, nunca passam por aqui — ver FOOTBALL_PROVIDER em env.ts).
 *
 * ✅ CONFIRMADO por duas amostras reais coladas pelo utilizador (pedido/resposta idênticos,
 * `GET /rounds/{id}?include=fixtures.odds.market;fixtures.odds.bookmaker;fixtures.participants;
 * league.country&filters=markets:1;bookmakers:2`):
 * - Forma da ronda: `{id, league_id, finished, is_current, starting_at, ending_at, fixtures: [...],
 *   league: {id, name, country: {...}}}`.
 * - Forma de cada fixture: `{id, league_id, round_id, state_id, name, starting_at
 *   ("YYYY-MM-DD HH:mm:ss", sem fuso explícito — assume-se UTC, mesma convenção já usada para a
 *   Pulsescore em parseServerDate() no frontend, nunca o fuso de quem faz o pedido), result_info,
 *   has_odds, has_premium_odds, odds: [...], participants: [...]}`.
 * - Forma de cada odd: `{fixture_id, market_id, bookmaker_id, label ("Home"/"Draw"/"Away"), value
 *   (string decimal, ex: "2.05"), total, handicap, stopped, winning, market: {id, name,
 *   developer_name}, bookmaker: {id, name}}`. `market.name`/`market_description` já vêm prontos
 *   a mostrar — usados diretamente, tal como `rawName` na Pulsescore, sem tabela de tradução.
 * - Forma de cada participante: `{id, name, meta: {location: "home"|"away", winner, position}}`.
 *
 * ⚠️ NÃO confirmado com uma amostra real (implementado contra os padrões documentados da
 * Sportmonks v3, mesma disciplina já usada nesta base de código para partes da Pulsescore sem
 * amostra — ver docs/SPORTS_DATA.md "Ainda por confirmar"):
 * - Autenticação via `?api_token=` na query string (não um header) — convenção pública da
 *   Sportmonks v3, nunca testada contra a chave real deste projeto.
 * - `GET /leagues?include=currentSeason.currentRound` para descobrir a ronda atual de cada liga
 *   (necessário para "todas as ligas", pedido explícito — a Sportmonks organiza jogos por
 *   ronda/liga, não por uma lista plana "todos os jogos futuros" como a Pulsescore).
 * - Estados (`state_id`) de fixture — sem amostra de um jogo por começar ainda, `getFootball
 *   Prematch()` classifica "agendado" comparando `starting_at` com a hora atual, não pelo
 *   `state_id`, para não inventar um mapeamento de enum não confirmado.
 */

function assertConfigured() {
  if (!env.SPORTMONKS_API_KEY) {
    throw Errors.badRequest("Sportmonks indisponível: SPORTMONKS_API_KEY não configurada neste ambiente.");
  }
}

async function sportmonksFetch<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
  assertConfigured();
  const url = new URL(`${env.SPORTMONKS_BASE_URL}${path}`);
  url.searchParams.set("api_token", env.SPORTMONKS_API_KEY);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));

  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    const body = await res.text();
    logger.error({ status: res.status, body: body.slice(0, 500), path }, "Erro na Sportmonks");
    throw Errors.internal(`Falha ao contactar a Sportmonks (${path})`, {
      upstreamStatus: res.status,
      upstreamBody: body.slice(0, 500),
    });
  }
  return res.json() as Promise<T>;
}

// --- Formas confirmadas (ver comentário do módulo) ---

interface SportmonksMarket {
  id: number;
  name: string;
  developer_name?: string;
}
interface SportmonksBookmaker {
  id: number;
  name: string;
}
interface SportmonksOdd {
  fixture_id: number;
  market_id: number;
  bookmaker_id: number;
  label: string;
  value: string;
  total?: string | null;
  handicap?: string | null;
  stopped?: boolean;
  winning?: boolean;
  market_description?: string;
  market?: SportmonksMarket;
  bookmaker?: SportmonksBookmaker;
}
interface SportmonksParticipant {
  id: number;
  name: string;
  short_code?: string;
  meta?: { location?: "home" | "away"; winner?: boolean; position?: number };
}
interface SportmonksFixture {
  id: number;
  league_id: number;
  round_id: number;
  state_id: number;
  name: string;
  starting_at: string; // "YYYY-MM-DD HH:mm:ss", sem fuso — assume-se UTC (ver comentário do módulo)
  result_info?: string | null;
  has_odds?: boolean;
  odds?: SportmonksOdd[];
  participants?: SportmonksParticipant[];
}
interface SportmonksLeague {
  id: number;
  name: string;
  country?: { name?: string; iso2?: string };
}
interface SportmonksRound {
  id: number;
  league_id: number;
  finished: boolean;
  is_current: boolean;
  starting_at: string;
  ending_at: string;
  fixtures: SportmonksFixture[];
  league?: SportmonksLeague;
}

/** GET /rounds/{id} com odds+participantes+liga — forma CONFIRMADA (ver comentário do módulo). */
export async function fetchRoundWithOdds(roundId: number, opts: { marketIds?: number[] } = {}): Promise<SportmonksRound> {
  const filters: string[] = [`bookmakers:${env.SPORTMONKS_BOOKMAKER_ID}`];
  if (opts.marketIds?.length) filters.push(`markets:${opts.marketIds.join(",")}`);
  return sportmonksFetch<SportmonksRound>(`/rounds/${roundId}`, {
    include: "fixtures.odds.market;fixtures.odds.bookmaker;fixtures.participants;league.country",
    filters: filters.join(";"),
  });
}

/** Agrupa as odds de uma fixture por mercado (market_id + total/handicap, para separar linhas
 * diferentes do mesmo mercado — ex: "Over/Under 2.5" vs "Over/Under 3.5" — mesma lógica já usada
 * para a Pulsescore em sortNumericMarketFamilies(), ver pulsescore/client.ts). */
function groupOddsIntoMarkets(odds: SportmonksOdd[] | undefined): LiveOdds[] {
  if (!odds?.length) return [];
  const groups = new Map<string, SportmonksOdd[]>();
  for (const odd of odds) {
    const line = odd.total ?? odd.handicap ?? "";
    const key = `${odd.market_id}:${line}`;
    const group = groups.get(key);
    if (group) group.push(odd);
    else groups.set(key, [odd]);
  }

  const result: LiveOdds[] = [];
  for (const group of groups.values()) {
    const first = group[0]!;
    const selections: Record<string, LiveSelection> = {};
    for (const odd of group) {
      const value = Number(odd.value);
      if (Number.isNaN(value)) continue;
      selections[odd.label] = { odd: value, isActive: !odd.stopped, canonicalName: odd.label };
    }
    if (!Object.keys(selections).length) continue;
    result.push({
      market: first.market?.name ?? first.market_description ?? `Mercado ${first.market_id}`,
      canonicalMarket: first.market?.developer_name,
      isActive: group.some((o) => !o.stopped),
      line: first.total ? Number(first.total) : first.handicap ? Number(first.handicap) : undefined,
      selections,
      sourceBookmaker: first.bookmaker?.name,
    });
  }
  return result;
}

function normalizeFixture(fixture: SportmonksFixture, league: SportmonksLeague | undefined): LiveEvent | null {
  const home = fixture.participants?.find((p) => p.meta?.location === "home");
  const away = fixture.participants?.find((p) => p.meta?.location === "away");
  if (!home || !away) return null; // sem as duas equipas identificadas, não é um jogo utilizável

  // "YYYY-MM-DD HH:mm:ss" -> ISO UTC explícito (ver aviso "não confirmado" no comentário do módulo).
  const startTimeIso = `${fixture.starting_at.trim().replace(" ", "T")}Z`;
  const hasKickedOff = new Date(startTimeIso).getTime() <= Date.now();

  return {
    id: `sportmonks:${fixture.id}`,
    sport: "football",
    league: league?.name ?? "Futebol",
    home: home.name,
    away: away.name,
    minuteOrPeriod: "",
    // Sem amostra de um jogo por começar/ao vivo (a única amostra recebida é sempre de uma ronda
    // já terminada), por isso NUNCA se assume "ao vivo" pelo state_id — só "agendado" (pela hora
    // real vs. agora) ou "terminado" (fallback), evitando inventar significado para um enum não
    // confirmado. A classificação Pré-jogo/Ao Vivo real fica por wiring futuro quando houver uma
    // amostra real de state_id de um jogo a decorrer.
    status: hasKickedOff ? "finished" : "scheduled",
    odds: groupOddsIntoMarkets(fixture.odds),
    updatedAt: new Date().toISOString(),
    source: "sportmonks",
    startTime: startTimeIso,
    country: league?.country?.iso2,
  };
}

const roundCache = new Map<number, { events: LiveEvent[]; fetchedAt: number }>();
const ROUND_CACHE_TTL_MS = 45_000; // mesmo TTL já usado para o pré-jogo da Pulsescore

/** Jogos de UMA ronda já normalizados para o formato LiveEvent comum — com cache curta (mesmo
 * padrão de prematch/service.ts) para não repetir o pedido a cada utilizador em simultâneo. */
export async function getRoundEvents(roundId: number, opts: { marketIds?: number[] } = {}): Promise<LiveEvent[]> {
  const cached = roundCache.get(roundId);
  if (cached && Date.now() - cached.fetchedAt < ROUND_CACHE_TTL_MS) return cached.events;

  const round = await fetchRoundWithOdds(roundId, opts);
  const events = round.fixtures.map((f) => normalizeFixture(f, round.league)).filter((e): e is LiveEvent => e !== null);
  roundCache.set(roundId, { events, fetchedAt: Date.now() });
  return events;
}

// --- ⚠️ Não confirmado: descoberta de ligas + ronda atual (ver aviso no comentário do módulo) ---
//
// PRIMEIRA TENTATIVA CORRIGIDA (2026-08-25): `include=currentSeason.currentRound` devolvia 404
// real da Sportmonks — "The requested include 'currentround' does not exist on Season" (code
// 5013), confirmado via o diagnóstico do admin (GET /admin/sportmonks/status). Não existe essa
// relação. Corrigido para `currentSeason.rounds` (todas as rondas da época atual — nome de
// relação muito mais convencional) e filtra-se pelo campo `is_current`, que esse sim está
// CONFIRMADO em ambas as amostras reais da ronda (ver comentário do módulo) — mais seguro do que
// voltar a adivinhar outro nome de relação sem amostra.

interface SportmonksRoundRef {
  id: number;
  is_current?: boolean;
}
interface SportmonksLeagueWithRounds extends SportmonksLeague {
  currentSeason?: { rounds?: SportmonksRoundRef[] };
}

function findCurrentRoundId(league: SportmonksLeagueWithRounds): number | undefined {
  return league.currentSeason?.rounds?.find((r) => r.is_current)?.id;
}

/** Diagnóstico — só a 1ª página de /leagues, sem paginar tudo, para o admin (ver
 * admin/routes.ts, GET /admin/sportmonks/status) conseguir ver rapidamente a forma real da
 * resposta (ou o erro real) sem esperar pelas até 20 páginas de fetchLeaguesWithCurrentRound().
 * `diagnosis` aponta em português a que nível exato a cadeia currentSeason -> rounds ->
 * is_current está a falhar (sem depender de copiar/colar o JSON bruto, difícil no telemóvel). */
export async function fetchLeaguesFirstPageRaw(): Promise<{
  totalOnPage: number;
  withCurrentSeason: number;
  withRounds: number;
  totalRoundsSeen: number;
  roundsWithIsCurrentTrue: number;
  withCurrentRound: number;
  sample: SportmonksLeagueWithRounds | null;
  diagnosis: string;
}> {
  const data = await sportmonksFetch<{ data: SportmonksLeagueWithRounds[]; pagination?: { has_more?: boolean } }>("/leagues", {
    include: "currentSeason.rounds",
    page: 1,
  });
  const leagues = data.data ?? [];
  const withCurrentSeason = leagues.filter((l) => l.currentSeason).length;
  const withRounds = leagues.filter((l) => (l.currentSeason?.rounds?.length ?? 0) > 0).length;
  const totalRoundsSeen = leagues.reduce((sum, l) => sum + (l.currentSeason?.rounds?.length ?? 0), 0);
  const roundsWithIsCurrentTrue = leagues.reduce((sum, l) => sum + (l.currentSeason?.rounds?.filter((r) => r.is_current).length ?? 0), 0);
  const withCurrentRound = leagues.filter((l) => findCurrentRoundId(l)).length;

  let diagnosis: string;
  if (leagues.length === 0) {
    diagnosis = "A Sportmonks devolveu 0 ligas nesta página — verificar se a chave/plano dá acesso a /leagues.";
  } else if (withCurrentSeason === 0) {
    diagnosis = "Nenhuma das ligas tem 'currentSeason' preenchido — este include pode não ser o nome certo, ou estas ligas não têm época ativa agora.";
  } else if (withRounds === 0) {
    diagnosis = `${withCurrentSeason} de ${leagues.length} ligas têm currentSeason, mas nenhuma tem 'rounds' preenchido — 'currentSeason.rounds' pode não estar a incluir mesmo as rondas.`;
  } else if (roundsWithIsCurrentTrue === 0) {
    diagnosis = `${totalRoundsSeen} rondas encontradas no total (em ${withRounds} ligas), mas nenhuma tem is_current:true — pode ser que estas 25 ligas estejam todas fora de época agora, ou o campo venha com outro nome.`;
  } else {
    diagnosis = `${withCurrentRound} ligas com ronda atual encontrada — a funcionar.`;
  }

  return { totalOnPage: leagues.length, withCurrentSeason, withRounds, totalRoundsSeen, roundsWithIsCurrentTrue, withCurrentRound, sample: leagues[0] ?? null, diagnosis };
}

export async function fetchLeaguesWithCurrentRound(): Promise<Array<{ leagueId: number; roundId: number }>> {
  const pairs: Array<{ leagueId: number; roundId: number }> = [];
  let page = 1;
  const maxPages = 20; // travão de segurança — "todas as ligas" pode ser uma lista grande
  while (page <= maxPages) {
    const data = await sportmonksFetch<{ data: SportmonksLeagueWithRounds[]; pagination?: { has_more?: boolean } }>("/leagues", {
      include: "currentSeason.rounds",
      page,
    });
    for (const league of data.data ?? []) {
      const roundId = findCurrentRoundId(league);
      if (roundId) pairs.push({ leagueId: league.id, roundId });
    }
    if (!data.pagination?.has_more) break;
    page += 1;
  }
  return pairs;
}
