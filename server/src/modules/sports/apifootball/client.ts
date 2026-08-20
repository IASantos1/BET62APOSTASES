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
 *
 * A resolução de nomes (equipa/liga Pulsescore -> id API-Football) NÃO vive aqui — vive em
 * mapping/teamMatcher.ts e mapping/leagueMatcher.ts (aliases, semelhança, cache permanente,
 * score de confiança, ver docs/TEAM_MAPPING.md). Este ficheiro só expõe as chamadas cruas à
 * API-Football: pesquisa (candidatos em bruto, sem filtrar) e os endpoints já indexados por id.
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

// --- Pesquisa crua (candidatos em bruto, sem escolher/filtrar) ------------------------------
// teamMatcher.ts/leagueMatcher.ts é que decidem qual candidato aceitar e com que confiança —
// isto só fala com a API-Football e devolve o que ela disser, tal como veio.

export interface ApiFootballTeamCandidate {
  id: number;
  name: string;
  country?: string;
}

export async function searchTeamCandidates(name: string): Promise<ApiFootballTeamCandidate[]> {
  const res = await apiFootballFetch<{ response: Array<{ team: { id: number; name: string; country?: string } }> }>("/teams", {
    search: name,
  });
  return res.response.map((r) => ({ id: r.team.id, name: r.team.name, country: r.team.country }));
}

export interface ApiFootballLeagueCandidate {
  id: number;
  name: string;
  seasons: Array<{ year: number; current: boolean }>;
}

// "Qualifiers"/"Play-offs"/etc. descrevem uma FASE, não uma competição própria, para ligas de
// clubes (Champions/Europa/Conference League) — a API-Football só tem a liga-mãe (ex: "UEFA
// Europa League"), por isso pesquisar literalmente "UEFA Europa League Qualifiers" devolve 0
// candidatos (CONFIRMADO: /leagues?search= com o sufixo -> results:0; sem o sufixo -> results:1,
// id 3, época atual 2026). Para seleções, porém, os qualifiers SÃO uma competição própria e
// pesquisável na API-Football (ex: "World Cup Qualifiers Europe") — por isso este sufixo só é
// removido como FALLBACK depois do nome completo devolver zero candidatos, nunca como primeira
// tentativa.
const LEAGUE_PHASE_SUFFIX_RE = /\s*[-–—:]?\s*\b(qualifiers?|qualifying(?:\s+round)?|play[- ]?offs?|preliminary round|group stage)\b.*$/i;

export async function searchLeagueCandidates(name: string): Promise<ApiFootballLeagueCandidate[]> {
  const res = await apiFootballFetch<{ response: Array<{ league: { id: number; name: string }; seasons: Array<{ year: number; current: boolean }> }> }>(
    "/leagues",
    { search: name }
  );
  if (res.response.length > 0) return res.response.map((r) => ({ id: r.league.id, name: r.league.name, seasons: r.seasons }));

  const stripped = name.replace(LEAGUE_PHASE_SUFFIX_RE, "").trim();
  if (!stripped || stripped === name) return [];
  const fallback = await apiFootballFetch<{ response: Array<{ league: { id: number; name: string }; seasons: Array<{ year: number; current: boolean }> }> }>(
    "/leagues",
    { search: stripped }
  );
  return fallback.response.map((r) => ({ id: r.league.id, name: r.league.name, seasons: r.seasons }));
}

export interface ApiFootballFixtureSearchResponse {
  response: Array<{
    fixture: { id: number; date: string };
    teams: { home: { id: number; name: string }; away: { id: number; name: string } };
  }>;
}

/**
 * Resolve o fixture_id do jogo entre duas equipas (por id) numa data. Melhor esforço: pesquisa
 * os jogos da equipa da casa nessa data exata (segundo sinal de confirmação, além do id da
 * equipa) e filtra pelo adversário certo. Sem resultado -> null, nunca inventa um id. Se houver
 * mais do que um (ex: taça a dobrar com a liga no mesmo dia — raro), regista um aviso e usa o
 * primeiro, por não haver mais nenhum dado (ex: hora exata) para desempatar com confiança.
 */
export async function findFixtureId(homeTeamId: number, awayTeamId: number, dateISO: string): Promise<number | null> {
  const res = await apiFootballFetch<ApiFootballFixtureSearchResponse>("/fixtures", { team: homeTeamId, date: dateISO });
  const matches = res.response.filter(
    (f) =>
      (f.teams.home.id === homeTeamId && f.teams.away.id === awayTeamId) ||
      (f.teams.home.id === awayTeamId && f.teams.away.id === homeTeamId)
  );
  if (matches.length > 1) {
    logger.warn(
      { homeTeamId, awayTeamId, dateISO, count: matches.length },
      "API-Football: mais do que um fixture encontrado para as mesmas equipas na mesma data — a usar o primeiro"
    );
  }
  return matches[0]?.fixture.id ?? null;
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
