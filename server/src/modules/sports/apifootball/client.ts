import { env } from "../../../config/env";
import { Errors } from "../../../lib/errors";
import { logger } from "../../../lib/logger";
import { TtlCache, cached } from "../../../lib/ttlCache";

/**
 * API-Football (v3.football.api-sports.io) REST client — statistics enrichment layer.
 *
 * Documentação oficial completa colada pelo utilizador em 2026-08-24 (o fetch direto a
 * www.api-football.com continua bloqueado neste ambiente de build — EGRESS_BLOCKED) — confirma
 * exatamente o que este ficheiro já implementava: header `x-apisports-key` (subscrição direta),
 * base `https://v3.football.api-sports.io`, todos os endpoints/parâmetros usados abaixo
 * (`/fixtures`, `/fixtures/statistics?fixture=`, `/fixtures/headtohead?h2h=`, `/predictions?fixture=`,
 * `/standings?league=&season=`, `/teams?search=`). Nenhuma discrepância encontrada.
 *
 * ⚠️ **Aviso da própria documentação, textual**: "A API está configurada para funcionar apenas
 * com solicitações GET e permite somente os cabeçalhos listados abaixo: x-apisports-key. Se você
 * fizer solicitações que não sejam do tipo GET ou adicionar cabeçalhos que não estejam na lista,
 * você receberá um erro da API. **Algumas estruturas (especialmente em JS, nodeJS...) adicionam
 * cabeçalhos extras automaticamente; você precisa removê-los para obter uma resposta da API.**"
 * — é por isto que `apiFootballFetch()` abaixo nunca usa uma lib HTTP com defaults próprios
 * (axios/superagent costumam injetar `Content-Type`/`Accept` automaticamente); usa sempre o
 * `fetch()` nativo do Node com um objeto `headers` contendo só a chave, nada mais.
 *
 * `getApiFootballStatus()` (`GET /status`) **não conta para a quota diária** (confirmado na
 * documentação) — é o diagnóstico ideal para confirmar chave/provider/ligação sem gastar pedidos
 * reais, exposto no admin (`GET /admin/apifootball/status`, ver `admin/routes.ts`).
 *
 * A resolução de nomes (equipa/liga Pulsescore -> id API-Football) NÃO vive aqui — vive em
 * mapping/teamMatcher.ts e mapping/leagueMatcher.ts (aliases, semelhança, cache permanente,
 * score de confiança, ver docs/TEAM_MAPPING.md). Este ficheiro só expõe as chamadas cruas à
 * API-Football: pesquisa (candidatos em bruto, sem filtrar) e os endpoints já indexados por id.
 */

// Host oficial por omissão da subscrição direta — usado para saber se API_FOOTBALL_BASE_URL
// ainda está no valor por omissão (nesse caso, o provider "rapidapi" troca-o automaticamente
// para o host da RapidAPI abaixo) ou se foi definido explicitamente pelo utilizador (nesse caso
// essa escolha explícita vence sempre, mesmo com provider="rapidapi").
const DIRECT_BASE_URL = "https://v3.football.api-sports.io";
const RAPIDAPI_BASE_URL = "https://api-football-v1.p.rapidapi.com/v3";

function resolveApiFootballBaseUrl(): string {
  if (env.API_FOOTBALL_BASE_URL !== DIRECT_BASE_URL) return env.API_FOOTBALL_BASE_URL;
  return env.API_FOOTBALL_PROVIDER === "rapidapi" ? RAPIDAPI_BASE_URL : DIRECT_BASE_URL;
}

// Duas formas de autenticação, dependendo de onde a chave foi obtida (spec explicada em
// docs/SPORTS_DATA.md): subscrição direta em api-football.com usa um único header
// "x-apisports-key"; subscrição via marketplace da RapidAPI usa dois headers diferentes
// ("x-rapidapi-key" + "x-rapidapi-host") e nunca aceita o formato direto — usar o header errado
// devolve sempre 401/403, para TODOS os pedidos, o que parece "nada de estatísticas chega nunca"
// em vez de um erro pontual.
function apiFootballHeaders(): Record<string, string> {
  if (env.API_FOOTBALL_PROVIDER === "rapidapi") {
    return { "x-rapidapi-key": env.API_FOOTBALL_KEY, "x-rapidapi-host": env.API_FOOTBALL_RAPIDAPI_HOST };
  }
  return { "x-apisports-key": env.API_FOOTBALL_KEY };
}

async function apiFootballFetch<T>(path: string, params: Record<string, string | number>): Promise<T> {
  if (!env.API_FOOTBALL_KEY) {
    throw Errors.badRequest("API-Football indisponível: API_FOOTBALL_KEY não configurada neste ambiente.", {
      reachedNetwork: false,
    });
  }

  const url = new URL(`${resolveApiFootballBaseUrl()}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));

  const res = await fetch(url, { headers: apiFootballHeaders() });
  if (!res.ok) {
    const body = await res.text();
    logger.error({ status: res.status, body, path, provider: env.API_FOOTBALL_PROVIDER }, "Erro na API-Football");
    // upstreamStatus/upstreamBody aqui em baixo servem o diagnóstico do admin (getApiFootballStatus,
    // GET /admin/apifootball/status) — sem isto o admin só via um 500 genérico, sem saber se a
    // API-Football respondeu 401 (chave errada), 403 (provider/plano errado) ou outra coisa.
    throw Errors.internal(`Falha ao contactar a API-Football (${path})`, {
      reachedNetwork: true,
      upstreamStatus: res.status,
      upstreamBody: body.slice(0, 500),
    });
  }
  return res.json() as Promise<T>;
}

export interface ApiFootballStatusResponse {
  response: {
    account: { firstname: string; lastname: string; email: string };
    subscription: { plan: string; end: string; active: boolean };
    requests: { current: number; limit_day: number };
  };
}

/** GET /status — confirmado na documentação oficial que NÃO conta para a quota diária. Serve
 * só para diagnóstico: se isto falhar, o problema é mesmo a chave/provider/rede — nenhuma
 * pesquisa de equipa/liga/fixture chegou a acontecer ainda. Exposto no admin (ver
 * `admin/routes.ts`, `GET /admin/apifootball/status`). */
export async function getApiFootballStatus(): Promise<ApiFootballStatusResponse> {
  return apiFootballFetch<ApiFootballStatusResponse>("/status", {});
}

export interface ApiFootballStatisticsResponse {
  response: Array<{
    team: { id: number; name: string };
    statistics: Array<{ type: string; value: number | string | null }>;
  }>;
}

// TTL curto (jogo ao vivo muda a cada minuto) só para aparar pedidos concorrentes pelo mesmo
// fixture (ex: vários utilizadores a ver o mesmo jogo no Match Tracker/endpoint unificado ao
// mesmo tempo) — não para "poupar" atualizações reais, ver docs/CACHING.md.
const statsCache = new TtlCache<ApiFootballStatisticsResponse>(15_000);
const statsInFlight = new Map<string, Promise<ApiFootballStatisticsResponse>>();

export async function getFixtureStatistics(fixtureId: number) {
  return cached(statsCache, statsInFlight, String(fixtureId), () =>
    apiFootballFetch<ApiFootballStatisticsResponse>("/fixtures/statistics", { fixture: fixtureId })
  );
}

export interface ApiFootballFixtureResponse {
  response: Array<{
    fixture: { id: number; status: { short: string; elapsed: number | null } };
    teams: { home: { name: string }; away: { name: string } };
    goals: { home: number | null; away: number | null };
  }>;
}

const fixtureByIdCache = new TtlCache<ApiFootballFixtureResponse>(15_000);
const fixtureByIdInFlight = new Map<string, Promise<ApiFootballFixtureResponse>>();

export async function getFixtureById(fixtureId: number) {
  return cached(fixtureByIdCache, fixtureByIdInFlight, String(fixtureId), () =>
    apiFootballFetch<ApiFootballFixtureResponse>("/fixtures", { id: fixtureId })
  );
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

export interface FixtureIdMatch {
  fixtureId: number;
  kickoffISO: string;
  invertedHomeAway: boolean; // true = a API-Football tem a casa/fora trocada em relação ao pedido
}

/**
 * Resolve o fixture da API-Football entre duas equipas (por id) numa data. Melhor esforço:
 * pesquisa os jogos da equipa da casa nessa data exata (segundo sinal de confirmação, além do
 * id da equipa) e filtra pelo adversário certo — incluindo a ordem invertida (a Pulsescore e a
 * API-Football podem discordar em qual das duas é "casa"; nunca se corrige o mandante/visitante
 * da Pulsescore por causa disto, ela continua a ser a fonte principal do evento — só se regista
 * que a inversão aconteceu, para auditoria). Sem resultado -> null, nunca inventa um id.
 *
 * Se houver mais do que um candidato (ex: taça a dobrar com a liga no mesmo dia — raro), e
 * `expectedKickoffISO` for dado, escolhe o mais próximo desse horário (comparação em UTC via
 * `Date`, nunca por comparação de strings) em vez de assumir sempre o primeiro — sem custo
 * extra de pedidos, a data de cada candidato já vem nesta mesma resposta.
 */
export async function findFixtureId(homeTeamId: number, awayTeamId: number, dateISO: string, expectedKickoffISO?: string): Promise<FixtureIdMatch | null> {
  const res = await apiFootballFetch<ApiFootballFixtureSearchResponse>("/fixtures", { team: homeTeamId, date: dateISO });
  const matches = res.response
    .map((f) => {
      if (f.teams.home.id === homeTeamId && f.teams.away.id === awayTeamId) return { f, invertedHomeAway: false };
      if (f.teams.home.id === awayTeamId && f.teams.away.id === homeTeamId) return { f, invertedHomeAway: true };
      return null;
    })
    .filter((m): m is { f: ApiFootballFixtureSearchResponse["response"][number]; invertedHomeAway: boolean } => m !== null);

  if (!matches.length) return null;

  let best = matches[0]!;
  if (matches.length > 1 && expectedKickoffISO) {
    const expected = new Date(expectedKickoffISO).getTime();
    let bestDiffMs = Math.abs(new Date(best.f.fixture.date).getTime() - expected);
    for (const m of matches.slice(1)) {
      const diffMs = Math.abs(new Date(m.f.fixture.date).getTime() - expected);
      if (diffMs < bestDiffMs) {
        best = m;
        bestDiffMs = diffMs;
      }
    }
    logger.info(
      { homeTeamId, awayTeamId, dateISO, count: matches.length, chosenFixtureId: best.f.fixture.id, diffMinutes: Math.round(bestDiffMs / 60000) },
      "API-Football: mais do que um fixture para as mesmas equipas na mesma data — escolhido o mais próximo do horário esperado"
    );
  } else if (matches.length > 1) {
    logger.warn(
      { homeTeamId, awayTeamId, dateISO, count: matches.length },
      "API-Football: mais do que um fixture encontrado para as mesmas equipas na mesma data (sem horário esperado para desempatar) — a usar o primeiro"
    );
  }
  if (best.invertedHomeAway) {
    logger.info({ homeTeamId, awayTeamId, fixtureId: best.f.fixture.id }, "API-Football: casa/fora invertidos em relação à Pulsescore — mandante da Pulsescore mantido");
  }

  return { fixtureId: best.f.fixture.id, kickoffISO: best.f.fixture.date, invertedHomeAway: best.invertedHomeAway };
}

export interface ApiFootballH2HResponse {
  response: Array<{
    fixture: { id: number; date: string; status: { short: string } };
    league: { name: string; country: string };
    teams: { home: { id: number; name: string }; away: { id: number; name: string } };
    goals: { home: number | null; away: number | null };
  }>;
}

// H2H é histórico (jogos já terminados) — só muda quando as duas equipas jogam de novo entre
// si, o que nunca acontece mais do que uma vez a cada tantas semanas/meses. TTL longo.
const h2hCache = new TtlCache<ApiFootballH2HResponse>(30 * 60_000);
const h2hInFlight = new Map<string, Promise<ApiFootballH2HResponse>>();

/** Confrontos diretos entre duas equipas — CONFIRMADO via amostra real colada pelo utilizador
 * (endpoint `/fixtures/headtohead?h2h={home}-{away}` e forma da resposta). */
export async function getHeadToHead(homeTeamId: number, awayTeamId: number, opts: { last?: number } = {}) {
  const last = opts.last ?? 5;
  return cached(h2hCache, h2hInFlight, `${homeTeamId}-${awayTeamId}:${last}`, () =>
    apiFootballFetch<ApiFootballH2HResponse>("/fixtures/headtohead", { h2h: `${homeTeamId}-${awayTeamId}`, last })
  );
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

// O próprio modelo da API-Football só atualiza de hora a hora — não faz sentido pedir mais
// vezes do que isso.
const predictionsCache = new TtlCache<ApiFootballPredictionsResponse>(15 * 60_000);
const predictionsInFlight = new Map<string, Promise<ApiFootballPredictionsResponse>>();

/** Previsão real da API-Football (forma, médias de golos, etc.) — CONFIRMADO via amostra real
 * colada pelo utilizador (endpoint `/predictions?fixture={id}` e forma da resposta). */
export async function getPredictions(fixtureId: number) {
  return cached(predictionsCache, predictionsInFlight, String(fixtureId), () =>
    apiFootballFetch<ApiFootballPredictionsResponse>("/predictions", { fixture: fixtureId })
  );
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

// A tabela só muda quando um jogo dessa liga termina — alguns minutos de TTL evitam pedir de
// novo a cada utilizador que abre a aba "Classificação" da mesma competição, sem atrasar
// visivelmente uma atualização real.
const standingsCache = new TtlCache<ApiFootballStandingsResponse>(5 * 60_000);
const standingsInFlight = new Map<string, Promise<ApiFootballStandingsResponse>>();

/** Tabela classificativa — CONFIRMADO via amostra real colada pelo utilizador (endpoint
 * `/standings?league={id}&season={year}` e forma da resposta, incluindo o agrupamento em
 * sub-arrays de `standings` para competições com várias fases/grupos). */
export async function getStandings(leagueId: number, season: number) {
  return cached(standingsCache, standingsInFlight, `${leagueId}:${season}`, () =>
    apiFootballFetch<ApiFootballStandingsResponse>("/standings", { league: leagueId, season })
  );
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
