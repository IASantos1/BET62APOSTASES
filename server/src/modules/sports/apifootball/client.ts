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

// --- Correspondência de nomes entre Pulsescore e API-Football -------------------------------
// São duas fontes totalmente independentes, sem NENHUM id partilhado (o `apiFootballFixtureId`
// declarado em types.ts nunca chega a ser preenchido) — a única forma de as ligar é pelo nome
// (equipa ou liga), que pode vir escrito de forma diferente em cada uma (acentos, sufixos como
// "FC"/"CF", abreviações como "Man United" vs "Manchester United"). Em vez de confiar às cegas
// no primeiro resultado da pesquisa, compara-se cada candidato com o nome pedido e só se aceita
// o melhor quando a semelhança é suficiente — caso contrário devolve-se null (sem dados) em vez
// de arriscar mostrar a equipa/liga errada. `findFixtureId()` usa ainda a data do jogo como
// segundo sinal de confirmação (só considera fixtures da equipa da casa nesse dia exato).
function normalizeName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(fc|cf|ac|afc|cd|ud|sd)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Palavras demasiado comuns em nomes de clube/liga para, sozinhas, servirem de sinal de
// correspondência (ex: "Real Madrid" não pode "passar" por "Real Sociedad" só por partilharem
// "real") — mas reduzida à lista mínima que não compromete abreviações legítimas onde a
// palavra partilhada É o único nome distintivo do próprio clube (ex: "Manchester United" ~
// "Man United" precisa de "united" continuar a contar, ver prefixMatches em tokenSimilarity).
const GENERIC_NAME_WORDS = new Set([
  "real", "deportivo", "sporting", "atletico", "athletic", "united", "city", "town",
  "county", "racing", "union", "national", "sport", "calcio", "club", "deportes",
]);

// Distância de edição normalizada (0..1) — apanha diferenças de grafia/acentuação entre as
// duas fontes (ex: "Bayern München" vs "Bayern Munich").
function editSimilarity(a: string, b: string): number {
  if (!a.length && !b.length) return 1;
  const m = a.length,
    n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
    }
  }
  return 1 - dp[m]![n]! / Math.max(m, n);
}

// Sobreposição de palavras entre os dois nomes já normalizados — só conta palavras "não
// genéricas" (GENERIC_NAME_WORDS) como sinal forte, e trata palavras não-partilhadas mas
// relacionadas por prefixo (ex: "man" abrevia "manchester") também como sinal forte, para não
// perder abreviações legítimas cujo único nome distintivo aparece truncado.
function tokenSimilarity(na: string, nb: string): number {
  const wa = na.split(" ").filter(Boolean);
  const wb = nb.split(" ").filter(Boolean);
  const sa = new Set(wa);
  const sb = new Set(wb);
  const common = [...sa].filter((w) => sb.has(w));
  const significant = common.filter((w) => !GENERIC_NAME_WORDS.has(w));
  const onlyA = [...sa].filter((w) => !sb.has(w));
  const onlyB = [...sb].filter((w) => !sa.has(w));
  let prefixMatches = 0;
  for (const wA of onlyA) {
    if (onlyB.some((wB) => wA.length >= 3 && wB.length >= 3 && (wA.startsWith(wB) || wB.startsWith(wA)))) prefixMatches++;
  }
  const strongCommon = significant.length + prefixMatches;
  const effectiveCommon = strongCommon > 0 ? strongCommon : common.length * 0.3;
  return effectiveCommon / Math.max(sa.size, sb.size);
}

/**
 * Semelhança entre dois nomes (equipa ou liga) — combina sobreposição de palavras (mais forte
 * para nomes com várias palavras) com distância de edição (apanha variações de grafia), com a
 * segunda "amortecida" quando a primeira é fraca — evita que dois nomes só partilhem um prefixo
 * comum longo (ex: "Deportivo Santani" ~ "Deportivo Capiata") passem por semelhantes só pela
 * distância de edição. Testado contra ~18 pares reais/adversariais (equipas com sufixos,
 * abreviações comuns, homónimos por país) antes de fixar os pesos — não é perfeito (alguns
 * homónimos continuam a passar, ex: "Arsenal" vs "Arsenal de Sarandí"), mas é uma rede de
 * segurança bem melhor do que aceitar sempre o primeiro resultado da pesquisa.
 */
function nameSimilarity(a: string, b: string): number {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const t = tokenSimilarity(na, nb);
  const e = editSimilarity(na, nb);
  const guardedEdit = t < 0.3 ? e * 0.55 : e;
  return Math.max(t, guardedEdit);
}

const MIN_NAME_SIMILARITY = 0.5;

function bestNameMatch<T>(query: string, candidates: T[], nameOf: (c: T) => string): { candidate: T; score: number } | null {
  let best: { candidate: T; score: number } | null = null;
  for (const c of candidates) {
    const score = nameSimilarity(query, nameOf(c));
    if (!best || score > best.score) best = { candidate: c, score };
  }
  return best;
}

export interface ApiFootballTeamSearchResponse {
  response: Array<{ team: { id: number; name: string; country?: string } }>;
}

/**
 * Resolve o id de uma equipa na API-Football pelo nome — melhor esforço: entre todos os
 * candidatos devolvidos pela pesquisa, escolhe o de nome mais parecido com o pedido, e só o
 * aceita se a semelhança passar o limiar (evita aceitar um clube homónimo de outro país). Sem
 * correspondência suficiente -> null, nunca inventa um id.
 */
export async function searchTeam(name: string): Promise<{ id: number; name: string } | null> {
  const res = await apiFootballFetch<ApiFootballTeamSearchResponse>("/teams", { search: name });
  const best = bestNameMatch(name, res.response, (r) => r.team.name);
  if (!best || best.score < MIN_NAME_SIMILARITY) {
    // Regista a lista completa de candidatos (não só o melhor) — distingue "a pesquisa não
    // devolveu nada" (candidatesCount: 0, plano/endpoint pode não cobrir esta equipa) de "a
    // pesquisa devolveu candidatos mas nenhum passou o limiar" (a heurística pode estar
    // demasiado rígida para este caso real).
    logger.info(
      {
        query: name,
        candidatesCount: res.response.length,
        candidates: res.response.slice(0, 5).map((r) => r.team.name),
        bestMatch: best?.candidate.team.name,
        score: best?.score ?? 0,
      },
      "API-Football: pesquisa de equipa sem correspondência suficientemente próxima"
    );
    return null;
  }
  return { id: best.candidate.team.id, name: best.candidate.team.name };
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
 * pesquisa os jogos da equipa da casa nessa data exata (segundo sinal de confirmação, além do
 * id da equipa) e filtra pelo adversário certo. Sem resultado -> null, nunca inventa um id. Se
 * houver mais do que um (ex: taça a dobrar com a liga no mesmo dia — raro), regista um aviso e
 * usa o primeiro, por não haver mais nenhum dado (ex: hora exata) para desempatar com confiança.
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
 * Resolve o id de uma liga na API-Football pelo nome (mesma lógica de correspondência por
 * semelhança do searchTeam() — evita aceitar uma competição homónima de outro país), e a
 * época atual (`current: true`, ou a mais recente da lista se nenhuma estiver marcada).
 */
export async function searchLeague(name: string): Promise<{ id: number; name: string; season: number } | null> {
  const res = await apiFootballFetch<ApiFootballLeagueSearchResponse>("/leagues", { search: name });
  const best = bestNameMatch(name, res.response, (r) => r.league.name);
  if (!best || best.score < MIN_NAME_SIMILARITY || !best.candidate.seasons.length) {
    logger.info(
      {
        query: name,
        candidatesCount: res.response.length,
        candidates: res.response.slice(0, 5).map((r) => r.league.name),
        bestMatch: best?.candidate.league.name,
        score: best?.score ?? 0,
      },
      "API-Football: pesquisa de liga sem correspondência suficientemente próxima"
    );
    return null;
  }
  const first = best.candidate;
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
