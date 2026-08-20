import { env } from "../../../config/env";
import { Errors } from "../../../lib/errors";
import { logger } from "../../../lib/logger";

/**
 * API-Football (v3.football.api-sports.io) REST client — statistics enrichment layer.
 *
 * NEEDS VALIDATION against https://www.api-football.com/documentation-v3 (blocked from this
 * environment). Implemented from documented knowledge:
 *   - Auth header: "x-apisports-key: <API_FOOTBALL_KEY>" when calling the direct host
 *     (v3.football.api-sports.io). If instead subscribed via RapidAPI, swap to
 *     "x-rapidapi-key" + "x-rapidapi-host" headers and the RapidAPI base URL.
 *   - Rate limits depend on plan (requests/day + requests/minute) — respect the
 *     `x-ratelimit-requests-remaining` response header and back off before going live.
 */

async function apiFootballFetch<T>(path: string, params: Record<string, string | number>): Promise<T> {
  if (!env.API_FOOTBALL_KEY) {
    throw Errors.badRequest("Estatísticas indisponíveis: API_FOOTBALL_KEY não configurada neste ambiente.");
  }

  const url = new URL(`${env.API_FOOTBALL_BASE_URL}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));

  const res = await fetch(url, { headers: { "x-apisports-key": env.API_FOOTBALL_KEY } });
  if (!res.ok) {
    const body = await res.text();
    logger.error({ status: res.status, body, path }, "Erro na API-Football");
    throw Errors.internal("Falha ao obter estatísticas da API-Football");
  }
  return res.json() as Promise<T>;
}

export interface ApiFootballStatisticsResponse {
  response: Array<{
    team: { id: number; name: string };
    statistics: Array<{ type: string; value: number | string | null }>;
  }>;
}

export async function getFixtureStatistics(fixtureId: number) {
  return apiFootballFetch<ApiFootballStatisticsResponse>("/fixtures/statistics", { fixture: fixtureId });
}

export interface ApiFootballFixtureResponse {
  response: Array<{
    fixture: { id: number; status: { short: string; elapsed: number | null } };
    teams: { home: { name: string }; away: { name: string } };
    goals: { home: number | null; away: number | null };
  }>;
}

export async function getFixtureById(fixtureId: number) {
  return apiFootballFetch<ApiFootballFixtureResponse>("/fixtures", { id: fixtureId });
}

export interface ApiFootballTeamSearchResponse {
  response: Array<{ team: { id: number; name: string; country?: string } }>;
}

/**
 * Resolve o id de uma equipa na API-Football pelo nome — não temos nenhum mapeamento
 * Pulsescore->API-Football de fixture/team id (o campo `apiFootballFixtureId` existe no tipo
 * mas nunca chegou a ser preenchido em lado nenhum), por isso isto é melhor esforço: usa o
 * primeiro resultado da pesquisa por nome, o que pode falhar/ambiguar em clubes com o mesmo
 * nome em países diferentes. Sem resultado -> null, nunca inventa um id.
 */
export async function searchTeam(name: string): Promise<{ id: number; name: string } | null> {
  const res = await apiFootballFetch<ApiFootballTeamSearchResponse>("/teams", { search: name });
  const first = res.response[0];
  return first ? { id: first.team.id, name: first.team.name } : null;
}

export interface ApiFootballH2HResponse {
  response: Array<{
    fixture: { id: number; date: string; status: { short: string } };
    league: { name: string; country: string };
    teams: { home: { id: number; name: string }; away: { id: number; name: string } };
    goals: { home: number | null; away: number | null };
  }>;
}

/** Confrontos diretos entre duas equipas — CONFIRMADO via amostra real colada pelo utilizador
 * (endpoint `/fixtures/headtohead?h2h={home}-{away}` e forma da resposta). */
export async function getHeadToHead(homeTeamId: number, awayTeamId: number, opts: { last?: number } = {}) {
  return apiFootballFetch<ApiFootballH2HResponse>("/fixtures/headtohead", {
    h2h: `${homeTeamId}-${awayTeamId}`,
    last: opts.last ?? 5,
  });
}

export interface HeadToHeadMatch {
  date: string;
  homeTeam: string;
  awayTeam: string;
  homeGoals: number | null;
  awayGoals: number | null;
  competition: string;
}

/**
 * Resolve as duas equipas pelo nome (ver searchTeam acima) e devolve os últimos confrontos
 * diretos entre elas. Nunca lança por equipa não encontrada — devolve [] nesse caso, para a UI
 * mostrar "sem dados" em vez de um erro genérico (a pesquisa por nome não é garantida).
 */
export async function getHeadToHeadByTeamNames(homeName: string, awayName: string): Promise<HeadToHeadMatch[]> {
  const [home, away] = await Promise.all([searchTeam(homeName), searchTeam(awayName)]);
  if (!home || !away) return [];
  const res = await getHeadToHead(home.id, away.id, { last: 5 });
  return res.response.map((f) => ({
    date: f.fixture.date,
    homeTeam: f.teams.home.name,
    awayTeam: f.teams.away.name,
    homeGoals: f.goals.home,
    awayGoals: f.goals.away,
    competition: f.league.name,
  }));
}

export interface ApiFootballFixtureSearchResponse {
  response: Array<{
    fixture: { id: number; date: string };
    teams: { home: { id: number; name: string }; away: { id: number; name: string } };
  }>;
}

/**
 * Resolve o fixture_id do jogo entre duas equipas (por id) numa data — usado porque
 * `LiveEvent.apiFootballFixtureId` nunca é preenchido (ver nota em searchTeam). Melhor esforço:
 * pesquisa os jogos da equipa da casa nessa data e filtra pelo adversário certo. Sem resultado
 * -> null, nunca inventa um id.
 */
export async function findFixtureId(homeTeamId: number, awayTeamId: number, dateISO: string): Promise<number | null> {
  const res = await apiFootballFetch<ApiFootballFixtureSearchResponse>("/fixtures", { team: homeTeamId, date: dateISO });
  const match = res.response.find(
    (f) =>
      (f.teams.home.id === homeTeamId && f.teams.away.id === awayTeamId) ||
      (f.teams.home.id === awayTeamId && f.teams.away.id === homeTeamId)
  );
  return match ? match.fixture.id : null;
}

/**
 * Combina searchTeam() + findFixtureId(): resolve o fixture_id do jogo atual entre duas
 * equipas pelo nome. `dateISO` opcional (jogos ao vivo não têm `startTime` — usa a data de
 * hoje como melhor esforço, assumindo que um jogo ao vivo está a decorrer hoje).
 */
export async function resolveFixtureIdByTeamNames(homeName: string, awayName: string, dateISO?: string): Promise<number | null> {
  const [home, away] = await Promise.all([searchTeam(homeName), searchTeam(awayName)]);
  if (!home || !away) return null;
  const date = dateISO ?? new Date().toISOString().slice(0, 10);
  return findFixtureId(home.id, away.id, date);
}

export interface ApiFootballPredictionsResponse {
  response: Array<{
    predictions: {
      winner: { id: number | null; name: string | null; comment: string | null };
      win_or_draw: boolean;
      advice: string;
      percent: { home: string; draw: string; away: string };
    };
  }>;
}

/** Previsão real da API-Football (forma, médias de golos, etc.) — CONFIRMADO via amostra real
 * colada pelo utilizador (endpoint `/predictions?fixture={id}` e forma da resposta). */
export async function getPredictions(fixtureId: number) {
  return apiFootballFetch<ApiFootballPredictionsResponse>("/predictions", { fixture: fixtureId });
}

export interface ApiFootballLeagueSearchResponse {
  response: Array<{
    league: { id: number; name: string };
    seasons: Array<{ year: number; current: boolean }>;
  }>;
}

/**
 * Resolve o id de uma liga na API-Football pelo nome, e a época atual (`current: true`, ou a
 * mais recente da lista se nenhuma estiver marcada) — mesma lógica de melhor esforço do
 * searchTeam(): usa o primeiro resultado da pesquisa, pode falhar/ambiguar em nomes de
 * competição duplicados entre países.
 */
export async function searchLeague(name: string): Promise<{ id: number; name: string; season: number } | null> {
  const res = await apiFootballFetch<ApiFootballLeagueSearchResponse>("/leagues", { search: name });
  const first = res.response[0];
  if (!first || !first.seasons.length) return null;
  const season = first.seasons.find((s) => s.current) ?? first.seasons[first.seasons.length - 1]!;
  return { id: first.league.id, name: first.league.name, season: season.year };
}

export interface ApiFootballStandingsResponse {
  response: Array<{
    league: {
      id: number;
      name: string;
      standings: Array<
        Array<{
          rank: number;
          team: { id: number; name: string; logo: string };
          points: number;
          goalsDiff: number;
          form: string | null;
          all: { played: number; win: number; draw: number; lose: number; goals: { for: number; against: number } };
        }>
      >;
    };
  }>;
}

/** Tabela classificativa — CONFIRMADO via amostra real colada pelo utilizador (endpoint
 * `/standings?league={id}&season={year}` e forma da resposta, incluindo o agrupamento em
 * sub-arrays de `standings` para competições com várias fases/grupos). */
export async function getStandings(leagueId: number, season: number) {
  return apiFootballFetch<ApiFootballStandingsResponse>("/standings", { league: leagueId, season });
}

export interface StandingsRow {
  rank: number;
  team: string;
  points: number;
  played: number;
  win: number;
  draw: number;
  lose: number;
  goalsFor: number;
  goalsAgainst: number;
  goalsDiff: number;
  form: string | null;
}

/**
 * Resolve a liga pelo nome (ver searchLeague) e devolve a tabela classificativa da primeira
 * fase/grupo. Nunca lança por liga não encontrada — devolve [] nesse caso, para a UI mostrar
 * "sem dados" em vez de um erro genérico.
 */
export async function getStandingsByLeagueName(leagueName: string): Promise<StandingsRow[]> {
  const league = await searchLeague(leagueName);
  if (!league) return [];
  const data = await getStandings(league.id, league.season);
  const table = data.response[0]?.league.standings[0] ?? [];
  return table.map((r) => ({
    rank: r.rank,
    team: r.team.name,
    points: r.points,
    played: r.all.played,
    win: r.all.win,
    draw: r.all.draw,
    lose: r.all.lose,
    goalsFor: r.all.goals.for,
    goalsAgainst: r.all.goals.against,
    goalsDiff: r.goalsDiff,
    form: r.form,
  }));
}
