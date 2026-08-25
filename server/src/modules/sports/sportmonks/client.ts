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

// Sem isto, um pedido lento/preso à Sportmonks (ex: /fixtures/between com uma janela grande de
// dias, muitos jogos em todas as ligas) prendia o pedido inteiro do utilizador indefinidamente —
// foi o que aconteceu em produção com GET /api/sports/sportmonks-debug a ficar "só a carregar".
// 15s chega para uma página normal; se exceder, falha a ESSA página em vez de nunca responder.
const SPORTMONKS_REQUEST_TIMEOUT_MS = 15_000;

async function sportmonksFetch<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
  assertConfigured();
  const url = new URL(`${env.SPORTMONKS_BASE_URL}${path}`);
  url.searchParams.set("api_token", env.SPORTMONKS_API_KEY);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SPORTMONKS_REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "application/json" }, signal: controller.signal });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "AbortError";
    logger.warn({ path, timedOut }, "Sportmonks: pedido falhou antes de resposta (rede ou timeout)");
    throw Errors.internal(`Falha ao contactar a Sportmonks (${path})`, {
      upstreamStatus: null,
      upstreamBody: timedOut ? `sem resposta em ${SPORTMONKS_REQUEST_TIMEOUT_MS / 1000}s` : String(err).slice(0, 200),
    });
  } finally {
    clearTimeout(timeout);
  }
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

// Ordem CANÓNICA fixa (Casa, Empate, Fora) para grupos Home/Draw/Away (ou 1/X/2) — confirmado
// numa amostra real de um jogo AO VIVO (Sabah vs Hapoel Be'er Sheva, Fulltime Result) que a
// Sportmonks manda as odds em ordem arbitrária ("Draw, Home, Away", não "Home, Draw, Away"); como
// `selections` abaixo é um objeto simples (a ordem das chaves = ordem de inserção), isso saía
// direto para o ecrã fora de ordem — reportado pelo utilizador ("o certo é Casa Empate Fora"). Só
// reordena quando o CONJUNTO de labels do grupo é reconhecidamente um destes (todas as labels
// batem no mapa, sem repetidas) — qualquer outro mercado (Over/Under, nomes de jogador/equipa,
// Dupla Hipótese...) fica exatamente na ordem em que veio, para não arriscar baralhar algo que
// não se reconhece com confiança.
const HOME_DRAW_AWAY_PRIORITY: Record<string, number> = { home: 0, "1": 0, draw: 1, tie: 1, x: 1, away: 2, "2": 2 };
function withCanonicalOutcomeOrder(group: SportmonksOdd[]): SportmonksOdd[] {
  const labels = group.map((o) => o.label.trim().toLowerCase());
  if (!labels.every((l) => l in HOME_DRAW_AWAY_PRIORITY) || new Set(labels).size !== labels.length) return group;
  return [...group].sort((a, b) => HOME_DRAW_AWAY_PRIORITY[a.label.trim().toLowerCase()]! - HOME_DRAW_AWAY_PRIORITY[b.label.trim().toLowerCase()]!);
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
  for (const rawGroup of groups.values()) {
    const group = withCanonicalOutcomeOrder(rawGroup);
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

// A ordem das odds que a Sportmonks manda é arbitrária (não vem já com o 1X2 primeiro) — sem
// isto, o cartão de pré-visualização (Destaques/lista de pré-jogo, que só mostra `odds[0]`, mesmo
// padrão do orderMarketsWithPrimaryFirst() da Pulsescore em pulsescore/client.ts) acabava por
// mostrar um mercado qualquer (ex: "Golos Ímpar/Par (Cartões)", "Marcador a Qualquer Momento") em
// vez do 1X2 — reportado pelo utilizador com um screenshot real da página Destaques a mostrar
// exatamente isso. "Fulltime Result" é o nome CONFIRMADO do mercado principal numa amostra real
// de produção (ver comentário do módulo).
function orderSportmonksMarketsWithPrimaryFirst(markets: LiveOdds[]): LiveOdds[] {
  const primaryIdx = markets.findIndex((m) => /full.?time result/i.test(m.market));
  if (primaryIdx <= 0) return markets;
  const ordered = [...markets];
  const [primary] = ordered.splice(primaryIdx, 1);
  ordered.unshift(primary!);
  return ordered;
}

// Junta as várias linhas do MESMO mercado (ex: "Alternative Goal Line" 0.5, 1.5, 2.5...) para
// ficarem lado a lado, ordenadas por linha ascendente, em vez de espalhadas pela lista consoante a
// ordem arbitrária em que a Sportmonks as manda — reportado pelo utilizador ("0.5 tá em cima, 1.5
// tá lá embaixo... vamos alinhar para que cada mercado esteja dentro de cada mercado"). Agrupa por
// NOME exato do mercado (ao contrário do sortNumericMarketFamilies() da Pulsescore, em
// pulsescore/client.ts, que extrai o número do NOME em texto — a Sportmonks não embute o número
// no nome nem na seleção, ver aviso em translateMarketDisplayName no frontend, por isso agrupa-se
// pelo nome e ordena-se pelo campo `line` estruturado, muito mais fiável do que tentar extrair um
// número de um texto que não o tem). Mantém a posição de cada GRUPO onde o seu primeiro membro
// apareceu — nunca reordena grupos diferentes entre si, só as linhas dentro do mesmo grupo. Linhas
// sem `line` definido (ver aviso "Team Total Goals" nunca a trazer) ficam no fim do grupo, mas
// continuam agrupadas com as restantes do mesmo mercado.
function sortSportmonksMarketFamilies(markets: LiveOdds[]): LiveOdds[] {
  const groups = new Map<string, LiveOdds[]>();
  const firstSeenOrder: string[] = [];
  for (const m of markets) {
    if (!groups.has(m.market)) {
      groups.set(m.market, []);
      firstSeenOrder.push(m.market);
    }
    groups.get(m.market)!.push(m);
  }
  const result: LiveOdds[] = [];
  for (const name of firstSeenOrder) {
    const group = groups.get(name)!;
    if (group.length > 1) group.sort((a, b) => (a.line ?? Infinity) - (b.line ?? Infinity));
    result.push(...group);
  }
  return result;
}

/** Ordem final aplicada aos mercados de um jogo da Sportmonks — mercado principal primeiro, depois
 * as várias linhas de cada mercado agrupadas e ordenadas. Usada tanto no pré-jogo (normalizeFixture
 * abaixo) como no Ao Vivo (normalizeLiveFixture, mais abaixo). */
function finalizeMarketOrder(odds: LiveOdds[]): LiveOdds[] {
  return sortSportmonksMarketFamilies(orderSportmonksMarketsWithPrimaryFirst(odds));
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
    odds: finalizeMarketOrder(groupOddsIntoMarkets(fixture.odds)),
    updatedAt: new Date().toISOString(),
    source: "sportmonks",
    startTime: startTimeIso,
    country: league?.country?.iso2,
  };
}

interface SportmonksFixtureWithLeague extends SportmonksFixture {
  league?: SportmonksLeague;
}

/**
 * ⚠️ NÃO confirmado por amostra real — tentativa alternativa à descoberta de "ronda atual"
 * (fetchLeaguesWithCurrentRound), que confirmou-se estruturalmente quebrada em produção: 0 ligas
 * com ronda atual em 20 páginas percorridas (ver GET /api/sports/sportmonks-debug). Padrão
 * documentado publicamente da Sportmonks v3 para "jogos num intervalo de datas, todas as ligas
 * de uma vez" — não depende de resolver ronda nenhuma, cada fixture já vem com a sua própria
 * `league` (via include `league.country`), evitando o problema todo da relação currentRound/
 * currentSeason.rounds que já falhou duas vezes.
 */
export async function fetchFixturesBetween(
  startDateISO: string,
  endDateISO: string,
  opts: { marketIds?: number[]; maxPages?: number } = {}
): Promise<LiveEvent[]> {
  const filters: string[] = [`bookmakers:${env.SPORTMONKS_BOOKMAKER_ID}`];
  if (opts.marketIds?.length) filters.push(`markets:${opts.marketIds.join(",")}`);

  const events: LiveEvent[] = [];
  let page = 1;
  // 8 por omissão (não 30) — cada página já traz odds+participantes+liga de TODAS as ligas para
  // aquele intervalo, um payload pesado; 30 páginas em série foi o que fez o diagnóstico ficar
  // preso "só a carregar" em produção (sem timeout nenhum antes desta correção — ver
  // SPORTMONKS_REQUEST_TIMEOUT_MS acima). Chamador pode pedir mais explicitamente se precisar.
  const maxPages = opts.maxPages ?? 8;
  while (page <= maxPages) {
    const data = await sportmonksFetch<{ data: SportmonksFixtureWithLeague[]; pagination?: { has_more?: boolean } }>(
      `/fixtures/between/${startDateISO}/${endDateISO}`,
      { include: "participants;odds.market;odds.bookmaker;league.country", filters: filters.join(";"), page }
    );
    for (const fixture of data.data ?? []) {
      const evt = normalizeFixture(fixture, fixture.league);
      if (evt) events.push(evt);
    }
    if (!data.pagination?.has_more) break;
    page += 1;
  }
  return events;
}

// --- Ao Vivo (/livescores/inplay) — CONFIRMADO por uma amostra real completa colada pelo
// utilizador (pedido explícito de migrar o Ao Vivo de futebol para a Sportmonks, ver
// sportmonks/live.ts para a lógica de polling/fusão com as odds). Forma real:
// `{data: [{id, league_id, state_id, name, starting_at, result_info, participants: [...],
// league: {...}, periods: [{id, type_id, started, ended, ticking, sort_order, description,
// time_added, period_length, minutes, seconds}], scores: [{participant_id, score: {goals,
// participant: "home"|"away"}, description}]}]}`. Duas coisas confirmadas importantes:
// - `state_id` NÃO é um valor único para "a decorrer" — a amostra real trouxe 2 e 22 em três
//   jogos todos a decorrer (com `periods` a "ticking" e sem `result_info`) — por isso não se
//   tenta interpretar o valor aqui, só se confia na presença na lista (o próprio endpoint já só
//   devolve jogos ao vivo, ao contrário de fetchFixturesBetween).
// - `scores` tem várias entradas por jogo (por período: "1ST_HALF", "2ND_HALF", "2ND_HALF_ONLY"),
//   mas a entrada com `description: "CURRENT"` é sempre o placar atual, uma por participante
//   ("home"/"away") — confirmado a bater com o resto da amostra (ex: 1-1 num jogo com um golo de
//   cada lado já visível nos eventos).
// A amostra real NÃO incluía odds (include usado pelo utilizador: league.country;events;periods;
// participants;round;scores, sem odds.market/odds.bookmaker) — este módulo também não as pede
// aqui, por prudência (nunca confirmado que este endpoint aceita esse include). Em vez disso,
// sportmonks/live.ts usa as odds já obtidas por fetchFixturesBetween (essa sim CONFIRMADA a trazer
// odds mesmo para jogos já começados — has_odds:true, 1425 odds numa amostra real).
interface SportmonksLiveScore {
  participant_id: number;
  score: { goals: number; participant: "home" | "away" };
  description: string; // "CURRENT" é o que interessa aqui — as outras são placares por período
}
interface SportmonksLivePeriod {
  ended: number | null; // null = este período ainda está a decorrer
  ticking: boolean;
  sort_order: number;
  description?: string; // "1st-half" | "2nd-half" | ...
  minutes: number;
  seconds: number;
}
interface SportmonksLiveFixture {
  id: number;
  league_id: number;
  state_id: number;
  name: string;
  starting_at: string;
  result_info?: string | null;
  participants?: SportmonksParticipant[];
  league?: SportmonksLeague;
  scores?: SportmonksLiveScore[];
  periods?: SportmonksLivePeriod[];
}

/** GET /livescores/inplay — forma CONFIRMADA (ver comentário acima). Devolve diretamente todos os
 * jogos de futebol a decorrer agora, de todas as ligas — ao contrário de fetchFixturesBetween(),
 * não precisa de nenhuma janela de datas nem de decidir "já começou" pela hora. */
export async function fetchLivescoresInplay(): Promise<SportmonksLiveFixture[]> {
  const data = await sportmonksFetch<{ data: SportmonksLiveFixture[] }>("/livescores/inplay", {
    include: "league.country;participants;periods;scores",
  });
  return data.data ?? [];
}

/** Normaliza uma fixture do /livescores/inplay para LiveEvent — `odds` vem de fora (ver comentário
 * acima), obtidas por quem chama através do cache já existente de fetchFixturesBetween. */
export function normalizeLiveFixture(fixture: SportmonksLiveFixture, odds: LiveOdds[]): LiveEvent | null {
  const home = fixture.participants?.find((p) => p.meta?.location === "home");
  const away = fixture.participants?.find((p) => p.meta?.location === "away");
  if (!home || !away) return null; // sem as duas equipas identificadas, não é um jogo utilizável

  const currentScores = (fixture.scores ?? []).filter((s) => s.description === "CURRENT");
  const homeScore = currentScores.find((s) => s.score.participant === "home")?.score.goals;
  const awayScore = currentScores.find((s) => s.score.participant === "away")?.score.goals;

  const periods = fixture.periods ?? [];
  const activePeriod = periods.find((p) => p.ended === null) ?? periods[periods.length - 1];
  const minuteOrPeriod = activePeriod ? `${activePeriod.minutes}'` : "";

  return {
    id: `sportmonks:${fixture.id}`,
    sport: "football",
    league: fixture.league?.name ?? "Futebol",
    home: home.name,
    away: away.name,
    homeScore,
    awayScore,
    minuteOrPeriod,
    status: "live",
    odds: finalizeMarketOrder(odds),
    updatedAt: new Date().toISOString(),
    source: "sportmonks",
    country: fixture.league?.country?.iso2,
  };
}

/**
 * Diagnóstico (ver routes.ts, GET /api/sports/sportmonks-live-debug) — duas amostras BRUTAS
 * (sem normalizar, todos os campos tal como a Sportmonks manda), num único pedido:
 *
 * 1. `startedSample`: o jogo de hoje cuja hora de início já passou mais recentemente — candidato
 *    a estar "a decorrer" agora. Pedido explícito do utilizador de migrar também o Ao Vivo de
 *    futebol para a Sportmonks. Ainda NUNCA se confirmou uma amostra real de um jogo A DECORRER
 *    (as únicas vistas até agora eram sempre de jogos por começar ou já terminados) — por isso
 *    `normalizeFixture()` nunca assume "ao vivo" pelo `state_id`, só compara a hora. Preciso de
 *    ver aqui o `state_id` real nesse estado, se há algum campo de placar ao vivo, e se as odds
 *    continuam presentes depois do apito inicial.
 * 2. `scheduledSample`: um jogo ainda por começar — para confirmar, campo a campo, PORQUE cerca de
 *    metade das entradas de mercados como "Alternative Goal Line"/"Team Total Goals" não têm
 *    `total`/`handicap` preenchido (confirmado a analisar uma amostra real de 198 jogos: 1089/2235
 *    "Alternative Goal Line" com linha, 0/1858 "Team Total Goals" com linha) — sem essa linha em
 *    lado nenhum, `groupOddsIntoMarkets()` não tem como mostrar o "Mais de 2.5"/"Menos de 2.5" real
 *    (reportado pelo utilizador: "mais/menos tem de aparecer 0.5 1.5 2.5... e não estão a
 *    aparecer"). Preciso de ver se `market_description` (ou outro campo ainda não usado) tem a
 *    linha nesses casos, antes de mudar `groupOddsIntoMarkets()`/`normalizeFixture()` às cegas.
 */
export async function fetchTodayRawFixtureForLiveDiagnosis(): Promise<{
  fetchedAt: string;
  totalFixturesToday: number;
  candidatesAlreadyStarted: number;
  startedSample: SportmonksFixtureWithLeague | null;
  scheduledSample: SportmonksFixtureWithLeague | null;
}> {
  const today = new Date().toISOString().slice(0, 10);
  const data = await sportmonksFetch<{ data: SportmonksFixtureWithLeague[] }>(`/fixtures/between/${today}/${today}`, {
    include: "participants;odds.market;odds.bookmaker;league.country",
    filters: `bookmakers:${env.SPORTMONKS_BOOKMAKER_ID}`,
    page: 1,
  });
  const fixtures = data.data ?? [];
  const now = Date.now();
  const started = fixtures.filter((f) => {
    const iso = `${f.starting_at.trim().replace(" ", "T")}Z`;
    return new Date(iso).getTime() <= now;
  });
  const scheduled = fixtures.filter((f) => !started.includes(f));
  // O jogo cuja hora de início está mais próxima de agora (mas já passou) — o melhor candidato a
  // estar mesmo a decorrer neste preciso momento, em vez de já ter terminado há horas.
  const startedSample = started.sort((a, b) => b.starting_at.localeCompare(a.starting_at))[0] ?? null;
  const scheduledSample = scheduled.sort((a, b) => a.starting_at.localeCompare(b.starting_at))[0] ?? null;
  return { fetchedAt: new Date().toISOString(), totalFixturesToday: fixtures.length, candidatesAlreadyStarted: started.length, startedSample, scheduledSample };
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
