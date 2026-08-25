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
  season_id: number;
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
// aqui. As odds ao vivo vêm de fetchInplayOddsForFixture() (GET /odds/inplay/fixtures/{id}, ver
// abaixo) — CONFIRMADO como o endpoint certo por diagnoseLiveOddsMovement() (as odds de
// fetchFixturesBetween/fetchFixtureDetail ficam congeladas desde antes do apito inicial; este
// endpoint tem `latest_bookmaker_update` a variar ao longo do jogo inteiro, prova real de que
// atualiza mesmo).
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
  // ⚠️ NÃO confirmado por amostra real neste endpoint em concreto (a amostra real de
  // /livescores/inplay usada para confirmar o resto desta interface não incluía `events`) — pedido
  // aqui na mesma porque `events.type` já se confirmou combinável com outros includes em
  // /fixtures/{id} (mesmo recurso "Fixture" nos dois endpoints, ver rate_limit.requested_entity).
  // Serve só para detectSuspendedReason() abaixo (pedido explícito do utilizador: mostrar "Grande
  // Chance"/"Revisão VAR" em vez de "Suspenso" genérico no mercado principal, MESMO sem a
  // Sportmonks confirmar o motivo da suspensão — é uma leitura NOSSA do evento mais recente, não
  // um campo da API) — se este include não for aceite aqui, `events` fica undefined e o mercado
  // suspenso mostra só "Suspenso" como já mostrava antes, nunca quebra.
  events?: SportmonksMatchEvent[];
}

/** GET /livescores/inplay — forma CONFIRMADA (ver comentário acima). Devolve diretamente todos os
 * jogos de futebol a decorrer agora, de todas as ligas — ao contrário de fetchFixturesBetween(),
 * não precisa de nenhuma janela de datas nem de decidir "já começou" pela hora. */
export async function fetchLivescoresInplay(): Promise<SportmonksLiveFixture[]> {
  const data = await sportmonksFetch<{ data: SportmonksLiveFixture[] }>("/livescores/inplay", {
    include: "league.country;participants;periods;scores;events.type",
  });
  return data.data ?? [];
}

/**
 * GET /odds/inplay/fixtures/{id} — CONFIRMADO por uma amostra real completa colada pelo utilizador
 * (várias odds do mesmo jogo com `latest_bookmaker_update` espalhado entre 19:00 e 19:38, ao longo
 * do jogo inteiro — prova de que ESTE endpoint atualiza mesmo durante o jogo, ao contrário de
 * GET /fixtures/{id}, cujas odds confirmaram-se congeladas desde antes do apito inicial, ver
 * diagnoseLiveOddsMovement()). Devolve uma lista PLANA de odds (não aninhada em fixture), cada uma
 * já com `market`/`bookmaker` incluídos — forma compatível com `SportmonksOdd` já usado no resto
 * do módulo (`groupOddsIntoMarkets`/`finalizeMarketOrder` reutilizados tal como estão). Labels
 * aqui confirmaram-se "1"/"X"/"2" para o mercado principal (não "Home"/"Draw"/"Away" como em
 * fetchFixturesBetween) — já cobertos por HOME_DRAW_AWAY_PRIORITY (ver withCanonicalOutcomeOrder).
 */
export async function fetchInplayOddsForFixture(fixtureId: number): Promise<LiveOdds[]> {
  const data = await sportmonksFetch<{ data: SportmonksOdd[] }>(`/odds/inplay/fixtures/${fixtureId}`, {
    include: "market;bookmaker",
  });
  return finalizeMarketOrder(groupOddsIntoMarkets(data.data));
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

  const finalOdds = finalizeMarketOrder(odds);
  const suspendedReason = finalOdds[0] && !finalOdds[0].isActive ? detectSuspendedReason(fixture.events) : undefined;

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
    odds: finalOdds,
    suspendedReason,
    updatedAt: new Date().toISOString(),
    source: "sportmonks",
    country: fixture.league?.country?.iso2,
  };
}

interface SportmonksFixtureState {
  short_name: string; // "NS" CONFIRMADO numa amostra real = "Not Started" (ver comentário abaixo)
}
// Eventos do jogo (golos/cartões/substituições) — CONFIRMADO por uma amostra real completa
// (`include=...;events.player;events.type;events.period`, fixture 19621957, São Paulo vs
// Mirassol). `type.developer_name` CONFIRMADOS nessa amostra: "GOAL" (golo, `result` traz o
// placar acumulado tipo "1-0"), "SUBSTITUTION" (`player_name`/`related_player_name` são os dois
// jogadores envolvidos — direção IN/OUT nunca confirmada por nenhum campo explícito, por isso
// mostrados lado a lado sem assumir qual saiu/entrou), "YELLOWCARD". `type_id:10` = revisão VAR —
// CONFIRMADO por DUAS amostras reais distintas (fixture 19788356: `info:"Offside"`,
// `addition:"Goal Disallowed"`, golo anulado; fixture 19622037: `addition:"Var"`, sem outro
// detalhe), ambas com `sub_type_id:1512` — nenhuma das duas trouxe `events.type` incluído, por
// isso identifica-se pelo `type_id` numérico (não pelo nome, nunca visto), e o texto usa
// `addition` para distinguir "revisão em curso"/"sem detalhe" de "golo anulado". Outros type_id
// não reconhecidos ficam sem tradução, mostrados com o nome tal como vier. `minute`/`extra_minute`
// CONFIRMADOS (ex: minute:45, extra_minute:4 = "45+4'", tempo adicionado).
interface SportmonksEventPlayer {
  display_name: string;
  name: string;
}
interface SportmonksEventType {
  name: string;
  developer_name: string;
}
interface SportmonksMatchEvent {
  participant_id: number;
  type_id: number;
  player_name?: string | null;
  related_player_name?: string | null;
  addition?: string | null;
  minute: number;
  extra_minute?: number | null;
  player?: SportmonksEventPlayer | null;
  type?: SportmonksEventType;
}
interface SportmonksFixtureDetail {
  id: number;
  round_id?: number; // CONFIRMADO numa amostra real desta MESMA fixture (19621839, ver comentário do módulo)
  season_id?: number; // idem — usado para /topscorers/seasons/{id} (ver getTopscorersBySeason abaixo)
  starting_at: string;
  state?: SportmonksFixtureState;
  participants?: SportmonksParticipant[];
  league?: SportmonksLeague;
  scores?: SportmonksLiveScore[];
  periods?: SportmonksLivePeriod[];
  odds?: SportmonksOdd[];
  events?: SportmonksMatchEvent[];
}

/**
 * GET /fixtures/{id} — CONFIRMADO por uma amostra real completa (`include=state;participants;
 * venue;scores;league;events...;predictions...`, sem `odds.market;odds.bookmaker` nessa amostra
 * em concreto — pedido aqui na mesma, mesmo padrão de include já confirmado a funcionar nos
 * outros endpoints da Sportmonks; se um dia se confirmar que não devolve odds neste endpoint,
 * fica só sem mercados, nunca inventa). Usado para o refresh "abrir o Match Tracker" de UM jogo
 * específico (mesma ideia do refresh da Pulsescore em pulsescore/client.ts) — mais leve do que
 * pedir o dia inteiro (fetchFixturesBetween) só para atualizar um jogo. `events.player;events.type;
 * events.period` juntado ao include (CONFIRMADO combinável com o resto numa amostra real completa,
 * fixture 19621957) para alimentar getMatchTimeline() abaixo, sem pedido extra nenhum.
 *
 * `state.short_name` CONFIRMADO: "NS" = "Not Started" — usado como sinal extra (par com a hora)
 * só para reforçar "ainda não começou"; outros valores de `state` NUNCA foram confirmados (ver
 * aviso no comentário do módulo), por isso um jogo já começado continua classificado só pela hora,
 * tal como em normalizeFixture()/normalizeLiveFixture().
 */
export async function fetchFixtureDetail(fixtureId: number): Promise<SportmonksFixtureDetail> {
  const data = await sportmonksFetch<{ data: SportmonksFixtureDetail }>(`/fixtures/${fixtureId}`, {
    include: "state;participants;league.country;scores;periods;odds.market;odds.bookmaker;events.player;events.type",
    filters: `bookmakers:${env.SPORTMONKS_BOOKMAKER_ID}`,
  });
  return data.data;
}

export interface MatchEventRow {
  minute: string; // "76'" ou "45+4'" (tempo adicionado)
  kind: "goal" | "yellowcard" | "redcard" | "substitution" | "var" | "other";
  label: string;
  playerName?: string; // ausente em eventos sem jogador associado (ex: revisão VAR), nunca "?"
  relatedPlayerName?: string; // só substituições — o outro jogador envolvido, sem assumir direção
  team: string;
  isHome: boolean;
}

const VAR_EVENT_TYPE_ID = 10; // CONFIRMADO (ver comentário de SportmonksMatchEvent acima)

/**
 * Motivo mostrado no mercado principal suspenso ("Suspenso" → "Grande Chance"/"Revisão VAR") —
 * pedido EXPLÍCITO do utilizador, por escolha deliberada dele mesmo sabendo que a Sportmonks NUNCA
 * confirmou nenhum campo com o motivo real de uma suspensão (só o sinal genérico `stopped`, ver
 * comentário de LiveSelection em types.ts): "a documentação fornece os dados e a gente recria
 * aqui a forma que a gente quer que apareça". Esta função é essa recriação — olha para o evento
 * mais recente do jogo (por minuto, depois minuto+tempo adicionado) e devolve "goal" se foi um
 * golo (developer_name "GOAL", confirmado), "var" se foi uma revisão VAR (type_id 10, confirmado —
 * ver VAR_EVENT_TYPE_ID acima), ou undefined para qualquer outro caso, incluindo sem eventos
 * disponíveis (endpoint sem `events`, ou combinação de include não suportada) — nunca inventa um
 * motivo sem ter pelo menos um evento real para se basear; o mercado mostra "Suspenso" genérico
 * nesse caso, como já mostrava antes desta função existir.
 */
function detectSuspendedReason(events: SportmonksMatchEvent[] | undefined): "goal" | "var" | undefined {
  if (!events?.length) return undefined;
  const minuteValue = (ev: SportmonksMatchEvent) => ev.minute * 100 + (ev.extra_minute ?? 0);
  const mostRecent = [...events].sort((a, b) => minuteValue(b) - minuteValue(a))[0]!;
  if (mostRecent.type_id === VAR_EVENT_TYPE_ID) return "var";
  if (mostRecent.type?.developer_name === "GOAL") return "goal";
  return undefined;
}

const EVENT_KIND_BY_DEVELOPER_NAME: Record<string, MatchEventRow["kind"]> = {
  GOAL: "goal",
  YELLOWCARD: "yellowcard",
  REDCARD: "redcard",
  SUBSTITUTION: "substitution",
};
const EVENT_LABEL_PT: Record<string, string> = {
  GOAL: "Golo",
  YELLOWCARD: "Cartão Amarelo",
  REDCARD: "Cartão Vermelho",
  SUBSTITUTION: "Substituição",
};

/** Linha do tempo do jogo (golos/cartões/substituições/revisões VAR), ordenada por minuto — usa os
 * mesmos `participants` já normalizados noutras funções deste módulo para saber a equipa/lado de
 * cada evento. Sem `events` na resposta (jogo sem esta informação disponível), devolve lista vazia. */
export function getMatchTimeline(fixture: SportmonksFixtureDetail): MatchEventRow[] {
  return (fixture.events ?? [])
    .map((ev) => {
      const developerName = ev.type?.developer_name ?? "";
      const team = fixture.participants?.find((p) => p.id === ev.participant_id);
      const isVar = ev.type_id === VAR_EVENT_TYPE_ID;
      const kind: MatchEventRow["kind"] = isVar ? "var" : EVENT_KIND_BY_DEVELOPER_NAME[developerName] ?? "other";
      const label = isVar ? (ev.addition === "Goal Disallowed" ? "Golo Anulado (VAR)" : "Revisão VAR") : EVENT_LABEL_PT[developerName] ?? ev.type?.name ?? "Evento";
      const playerName = ev.player?.display_name ?? ev.player_name ?? undefined;
      return {
        minute: ev.extra_minute ? `${ev.minute}+${ev.extra_minute}'` : `${ev.minute}'`,
        minuteValue: ev.minute * 100 + (ev.extra_minute ?? 0),
        kind,
        label,
        playerName,
        relatedPlayerName: developerName === "SUBSTITUTION" ? (ev.related_player_name ?? undefined) : undefined,
        team: team?.name ?? "",
        isHome: team?.meta?.location === "home",
      };
    })
    .sort((a, b) => a.minuteValue - b.minuteValue)
    .map(({ minuteValue: _minuteValue, ...row }) => row);
}

/** Normaliza a resposta de fetchFixtureDetail() para LiveEvent — usado só para o refresh on-demand
 * de UM jogo (ver routes.ts, GET /events/:id/refresh). */
export function normalizeFixtureDetail(fixture: SportmonksFixtureDetail): LiveEvent | null {
  const home = fixture.participants?.find((p) => p.meta?.location === "home");
  const away = fixture.participants?.find((p) => p.meta?.location === "away");
  if (!home || !away) return null;

  const startTimeIso = `${fixture.starting_at.trim().replace(" ", "T")}Z`;
  const hasKickedOff = new Date(startTimeIso).getTime() <= Date.now();
  const isScheduled = fixture.state?.short_name === "NS" || !hasKickedOff;

  const currentScores = (fixture.scores ?? []).filter((s) => s.description === "CURRENT");
  const homeScore = currentScores.find((s) => s.score.participant === "home")?.score.goals;
  const awayScore = currentScores.find((s) => s.score.participant === "away")?.score.goals;

  const periods = fixture.periods ?? [];
  const activePeriod = periods.find((p) => p.ended === null) ?? periods[periods.length - 1];
  const minuteOrPeriod = !isScheduled && activePeriod ? `${activePeriod.minutes}'` : "";

  const finalOdds = finalizeMarketOrder(groupOddsIntoMarkets(fixture.odds));
  const suspendedReason = finalOdds[0] && !finalOdds[0].isActive ? detectSuspendedReason(fixture.events) : undefined;

  return {
    id: `sportmonks:${fixture.id}`,
    sport: "football",
    league: fixture.league?.name ?? "Futebol",
    home: home.name,
    away: away.name,
    homeScore: isScheduled ? undefined : homeScore,
    awayScore: isScheduled ? undefined : awayScore,
    minuteOrPeriod,
    // "live" para qualquer jogo já começado sem "NS" — sem confirmação de outros valores de
    // state para "terminado" (ver aviso acima), esta função é só para refresh on-demand ao abrir
    // um jogo que o frontend já sabe (pela secção onde estava) que é pré-jogo ou ao vivo; o caso
    // raro de reabrir mesmo no instante em que termina fica coberto pelo merge do frontend, que
    // nunca troca mercados já mostrados por uma resposta mais pobre.
    status: isScheduled ? "scheduled" : "live",
    odds: finalOdds,
    suspendedReason,
    updatedAt: new Date().toISOString(),
    source: "sportmonks",
    startTime: startTimeIso,
    country: fixture.league?.country?.iso2,
  };
}

/**
 * Diagnóstico (ver routes.ts, GET /api/sports/sportmonks-odds-movement-debug) — pedido explícito
 * do utilizador ("odds em ao vivo não está funcionando", "continuam paradas/iguais" mesmo depois
 * da cache de 15s e do refresh on-demand ao abrir o jogo). Antes de mexer mais em código, esta
 * função responde a uma pergunta em falta: a Sportmonks está mesmo a mandar valores DIFERENTES
 * para o mesmo jogo ao vivo ao longo do tempo através deste endpoint (GET /fixtures/{id}), ou o
 * has_odds:true/has_premium_odds:true só significa "há odds" (o snapshot de pré-jogo, congelado
 * desde o apito inicial) sem estas se atualizarem durante o jogo? Pega no primeiro jogo ao vivo
 * agora, pede as suas odds duas vezes com um intervalo, e compara o mercado principal (Fulltime
 * Result) valor a valor — nunca assumido, sempre confirmado com uma amostra real.
 */
export async function diagnoseLiveOddsMovement(waitMs = 8_000): Promise<{
  fixtureId: number | null;
  fixtureName: string | null;
  waitedMs: number;
  snapshot1: Record<string, number> | null;
  snapshot2: Record<string, number> | null;
  changed: boolean | null;
  diagnosis: string;
}> {
  const live = await fetchLivescoresInplay();
  if (!live.length) {
    return { fixtureId: null, fixtureName: null, waitedMs: 0, snapshot1: null, snapshot2: null, changed: null, diagnosis: "Nenhum jogo ao vivo neste momento — tentar de novo durante um jogo a decorrer." };
  }
  const fixture = live[0]!;

  const snapshotOf = async (): Promise<Record<string, number>> => {
    const detail = await fetchFixtureDetail(fixture.id);
    const primary = groupOddsIntoMarkets(detail.odds).find((m) => /full.?time result/i.test(m.market));
    const out: Record<string, number> = {};
    if (primary) for (const [label, sel] of Object.entries(primary.selections)) out[label] = sel.odd;
    return out;
  };

  const snapshot1 = await snapshotOf();
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  const snapshot2 = await snapshotOf();

  const keys = new Set([...Object.keys(snapshot1), ...Object.keys(snapshot2)]);
  let changed = false;
  for (const k of keys) {
    if (snapshot1[k] !== snapshot2[k]) changed = true;
  }

  let diagnosis: string;
  if (!Object.keys(snapshot1).length && !Object.keys(snapshot2).length) {
    diagnosis = `Este jogo (${fixture.name}) não devolveu nenhuma odd de Fulltime Result em nenhuma das duas vezes — o problema pode ser falta de odds mesmo, não movimento.`;
  } else if (changed) {
    diagnosis = `Os valores MUDARAM entre os dois pedidos (${waitMs / 1000}s de intervalo) — a Sportmonks está mesmo a atualizar as odds ao vivo, o problema deve estar do nosso lado (cache/refresh).`;
  } else {
    diagnosis = `Os valores ficaram EXATAMENTE IGUAIS nos dois pedidos (${waitMs / 1000}s de intervalo) — sinal de que este endpoint pode não estar a devolver odds atualizadas durante o jogo (pode ser só o snapshot de pré-jogo congelado), não é um problema da nossa cache.`;
  }

  return { fixtureId: fixture.id, fixtureName: fixture.name, waitedMs: waitMs, snapshot1, snapshot2, changed, diagnosis };
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

// --- round_id/season_id de uma fixture — CONFIRMADOS por amostras reais de TRÊS endpoints
// diferentes da Sportmonks, todos partilhando o mesmo recurso base "Fixture" (mesmo
// `rate_limit.requested_entity`, ver aviso no comentário do módulo): a fixture 19621839
// (/fixtures/{id}, São Paulo vs Bragantino) trouxe `"season_id": 26763, ..., "round_id": 396698`
// como campos simples, sem precisar de nenhum `include` especial — o mesmo aconteceu numa fixture
// de /livescores/inplay (19622025, `"season_id": 26763, "round_id": 396717`). Por isso
// `fetchFixtureDetail()` (GET /fixtures/{id}) já chega para descobrir os dois de qualquer jogo da
// Sportmonks, sem pedidos extra — usado por resolveRoundAndSeasonId() abaixo para ligar a
// Classificação e os Artilheiros a um jogo específico.
const fixtureRoundSeasonCache = new Map<number, { roundId: number; seasonId: number }>();

/** round_id/season_id de uma fixture não mudam depois de agendada — cache permanente (sem TTL,
 * ao contrário das outras caches deste módulo), para não repetir GET /fixtures/{id} sempre que se
 * abre a Classificação ou os Artilheiros do mesmo jogo. Sem os dois confirmados na resposta,
 * devolve null — nunca inventa um round/season a partir de outro jogo. */
export async function resolveRoundAndSeasonId(fixtureId: number): Promise<{ roundId: number; seasonId: number } | null> {
  const cached = fixtureRoundSeasonCache.get(fixtureId);
  if (cached) return cached;
  const detail = await fetchFixtureDetail(fixtureId);
  if (!detail.round_id || !detail.season_id) return null;
  const resolved = { roundId: detail.round_id, seasonId: detail.season_id };
  fixtureRoundSeasonCache.set(fixtureId, resolved);
  return resolved;
}

const fixtureTeamIdsCache = new Map<number, { homeTeamId: number; awayTeamId: number }>();

/** IDs (Sportmonks) das duas equipas de uma fixture — mesma fonte/cache permanente de
 * resolveRoundAndSeasonId acima (GET /fixtures/{id}, `participants[].id` + `meta.location`, já
 * CONFIRMADO desde normalizeFixtureDetail()). Usado por getTeamFormForFixture() abaixo para saber
 * de que duas equipas pedir o calendário (/schedules/teams/{id}). */
async function resolveTeamIds(fixtureId: number): Promise<{ homeTeamId: number; awayTeamId: number } | null> {
  const cached = fixtureTeamIdsCache.get(fixtureId);
  if (cached) return cached;
  const detail = await fetchFixtureDetail(fixtureId);
  const home = detail.participants?.find((p) => p.meta?.location === "home");
  const away = detail.participants?.find((p) => p.meta?.location === "away");
  if (!home || !away) return null;
  const resolved = { homeTeamId: home.id, awayTeamId: away.id };
  fixtureTeamIdsCache.set(fixtureId, resolved);
  return resolved;
}

// --- Classificação (/standings/seasons/{seasonId}) — CONFIRMADO por DUAS amostras reais coladas
// pelo utilizador: primeiro `/standings/rounds/{roundId}` (ronda 396700, sem `form`/`rule`), depois
// `/standings/seasons/{seasonId}?include=participant;form;league;stage;group;details.type;
// rule.type` (época 26763, mesmas 20 equipas). Trocado de rounds para seasons porque rounds devolve
// a tabela TAL COMO ESTAVA naquela ronda específica (a do jogo que originou o pedido, ver
// resolveRoundAndSeasonId) — para um jogo de uma ronda já passada isso mostraria uma tabela
// desatualizada, não a classificação atual; seasons devolve sempre a tabela mais recente da época
// inteira, o que é o que faz sentido numa aba "Classificação". Forma de cada linha: `{id,
// league_id, season_id, stage_id, round_id, participant_id, position, points, result, details:
// [{type_id, value, type: {developer_name, ...}}], participant: {id, name, short_code,
// image_path}, form: [{fixture_id, form: "W"|"D"|"L", sort_order}], rule: {type: {name,
// developer_name}} | null}`. `details` identifica-se por `type.developer_name` (nunca pela posição
// no array); os nomes confirmados usados abaixo (OVERALL_MATCHES, OVERALL_WINS, OVERALL_DRAWS,
// OVERALL_LOST, OVERALL_SCORED, OVERALL_CONCEDED, OVERALL_GOAL_DIFFERENCE, EXPECTED_POINTS) vieram
// da amostra de rounds; a de seasons trouxe os mesmos nomes outra vez, confirmando que são
// estáveis entre os dois endpoints. `form` vem ordenado por `sort_order` CRESCENTE = jogo mais
// ANTIGO primeiro (confirmado comparando sort_order 1 com o fixture_id de uma ronda inicial da
// época, e sort_order mais alto com uma ronda recente) — por isso pega-se nos ÚLTIMOS elementos do
// array (maior sort_order), não nos primeiros, para os jogos mais recentes. `rule` identifica a
// zona da tabela (`type.name`, ex: "CONMEBOL Libertadores", "Relegation") — `null` para posições
// sem zona associada (meio da tabela), confirmado nas próprias linhas 12/13/14/15/16 da amostra.
interface SportmonksStandingDetailType {
  id: number;
  name: string;
  developer_name: string;
}
interface SportmonksStandingDetail {
  type_id: number;
  value: number;
  type?: SportmonksStandingDetailType;
}
interface SportmonksStandingParticipant {
  id: number;
  name: string;
  short_code?: string;
  image_path?: string;
}
interface SportmonksStandingFormEntry {
  fixture_id: number;
  form: string; // "W" | "D" | "L" — CONFIRMADO
  sort_order: number;
}
interface SportmonksStandingRuleType {
  name: string;
  developer_name: string;
}
interface SportmonksStandingRule {
  type?: SportmonksStandingRuleType;
}
interface SportmonksStandingRow {
  id: number;
  league_id: number;
  season_id: number;
  round_id: number;
  participant_id: number;
  position: number;
  points: number;
  result?: string;
  details?: SportmonksStandingDetail[];
  participant?: SportmonksStandingParticipant;
  form?: SportmonksStandingFormEntry[];
  rule?: SportmonksStandingRule | null;
}

async function fetchStandingsBySeason(seasonId: number): Promise<SportmonksStandingRow[]> {
  const data = await sportmonksFetch<{ data: SportmonksStandingRow[] }>(`/standings/seasons/${seasonId}`, {
    include: "participant;form;league;stage;group;details.type;rule.type",
  });
  return data.data ?? [];
}

const standingsCache = new Map<number, { rows: SportmonksStandingRow[]; fetchedAt: number }>();
const STANDINGS_CACHE_TTL_MS = 5 * 60_000; // mesmo TTL já usado para a classificação da API-Football

/** Classificação de UMA época, com cache curta (mesmo padrão de getRoundEvents acima). */
export async function getStandingsBySeason(seasonId: number): Promise<SportmonksStandingRow[]> {
  const cached = standingsCache.get(seasonId);
  if (cached && Date.now() - cached.fetchedAt < STANDINGS_CACHE_TTL_MS) return cached.rows;
  const rows = await fetchStandingsBySeason(seasonId);
  standingsCache.set(seasonId, { rows, fetchedAt: Date.now() });
  return rows;
}

export interface StandingsTableRow {
  rank: number;
  team: string;
  teamLogo?: string;
  points: number;
  played?: number;
  win?: number;
  draw?: number;
  lose?: number;
  goalsFor?: number;
  goalsAgainst?: number;
  goalsDiff?: number;
  expectedPoints?: number;
  form?: Array<"W" | "D" | "L">; // últimos 5 jogos, mais recente primeiro
  zoneLabel?: string; // ex: "CONMEBOL Libertadores", "Relegation" — undefined quando não há zona
}

function standingDetailValue(row: SportmonksStandingRow, developerName: string): number | undefined {
  return row.details?.find((d) => d.type?.developer_name === developerName)?.value;
}

/** Normaliza uma linha de /standings/seasons/{id} para o formato consumido pelo frontend — mesmos
 * nomes de campo já usados pela rota equivalente da API-Football (GET /events/:id/standings),
 * para o frontend (renderStandings() em app.js) não precisar de saber qual das duas fontes está a
 * usar. */
export function normalizeStandingsRow(row: SportmonksStandingRow): StandingsTableRow {
  const form = [...(row.form ?? [])]
    .sort((a, b) => a.sort_order - b.sort_order)
    .slice(-5)
    .reverse()
    .map((f) => f.form as "W" | "D" | "L");
  return {
    rank: row.position,
    team: row.participant?.name ?? `Equipa ${row.participant_id}`,
    teamLogo: row.participant?.image_path,
    points: row.points,
    played: standingDetailValue(row, "OVERALL_MATCHES"),
    win: standingDetailValue(row, "OVERALL_WINS"),
    draw: standingDetailValue(row, "OVERALL_DRAWS"),
    lose: standingDetailValue(row, "OVERALL_LOST"),
    goalsFor: standingDetailValue(row, "OVERALL_SCORED"),
    goalsAgainst: standingDetailValue(row, "OVERALL_CONCEDED"),
    goalsDiff: standingDetailValue(row, "OVERALL_GOAL_DIFFERENCE"),
    expectedPoints: standingDetailValue(row, "EXPECTED_POINTS"),
    form: form.length ? form : undefined,
    zoneLabel: row.rule?.type?.name,
  };
}

// --- Artilheiros (/topscorers/seasons/{seasonId}) — CONFIRMADO por uma amostra real completa
// colada pelo utilizador (época 26763, Brasileirão Série A, filtro `seasontopscorerTypes:208`).
// `type_id:208` = "Goal Topscorer", CONFIRMADO na própria amostra (`type.name`) — o único
// ranking (golos) alguma vez confirmado; outros rankings (ex: assistências) teriam outro type_id
// nunca visto, por isso não se expõe escolha de tipo. Forma de cada entrada: `{id, season_id,
// player_id, position (posição no ranking), total (golos), participant_id, participant: {id,
// name, short_code, image_path}, player: {id, display_name, name, image_path, date_of_birth,
// height, weight, nationality: {name, image_path}, position: {name}}}`. A paginação real é por
// cursor (`pagination.next_cursor`), nunca confirmada a funcionar com `page` — por isso só se pede
// a 1ª página (50 entradas por omissão, já mais do que suficiente para um top 10/20 de artilheiros).
interface SportmonksTopscorerNationality {
  name: string;
  image_path?: string;
}
interface SportmonksTopscorerPosition {
  name: string;
}
interface SportmonksTopscorerPlayer {
  id: number;
  display_name: string;
  name: string;
  image_path?: string;
  nationality?: SportmonksTopscorerNationality;
  position?: SportmonksTopscorerPosition;
}
interface SportmonksTopscorerParticipant {
  id: number;
  name: string;
  short_code?: string;
  image_path?: string;
}
interface SportmonksTopscorerEntry {
  id: number;
  season_id: number;
  player_id: number;
  position: number;
  total: number;
  participant_id: number;
  participant?: SportmonksTopscorerParticipant;
  player?: SportmonksTopscorerPlayer;
}

const GOAL_TOPSCORER_TYPE_ID = 208; // CONFIRMADO ("Goal Topscorer", ver comentário acima)

async function fetchTopscorersBySeason(seasonId: number): Promise<SportmonksTopscorerEntry[]> {
  const data = await sportmonksFetch<{ data: SportmonksTopscorerEntry[] }>(`/topscorers/seasons/${seasonId}`, {
    include: "type;participant;player.nationality;player.position;season.league",
    filters: `seasontopscorerTypes:${GOAL_TOPSCORER_TYPE_ID}`,
  });
  return data.data ?? [];
}

const topscorersCache = new Map<number, { entries: SportmonksTopscorerEntry[]; fetchedAt: number }>();
const TOPSCORERS_CACHE_TTL_MS = 5 * 60_000;

/** Artilheiros de UMA época, com cache curta (mesmo padrão de getStandingsBySeason acima). */
export async function getTopscorersBySeason(seasonId: number): Promise<SportmonksTopscorerEntry[]> {
  const cached = topscorersCache.get(seasonId);
  if (cached && Date.now() - cached.fetchedAt < TOPSCORERS_CACHE_TTL_MS) return cached.entries;
  const entries = await fetchTopscorersBySeason(seasonId);
  topscorersCache.set(seasonId, { entries, fetchedAt: Date.now() });
  return entries;
}

export interface TopscorerRow {
  rank: number;
  goals: number;
  playerName: string;
  playerPhoto?: string;
  nationality?: string;
  nationalityFlag?: string;
  position?: string;
  team: string;
  teamLogo?: string;
}

export function normalizeTopscorerEntry(entry: SportmonksTopscorerEntry): TopscorerRow {
  return {
    rank: entry.position,
    goals: entry.total,
    playerName: entry.player?.display_name ?? entry.player?.name ?? `Jogador ${entry.player_id}`,
    playerPhoto: entry.player?.image_path,
    nationality: entry.player?.nationality?.name,
    nationalityFlag: entry.player?.nationality?.image_path,
    position: entry.player?.position?.name,
    team: entry.participant?.name ?? `Equipa ${entry.participant_id}`,
    teamLogo: entry.participant?.image_path,
  };
}

// --- Forma recente/próximos jogos de uma equipa (/schedules/teams/{teamId}) — CONFIRMADO por uma
// amostra real completa colada pelo utilizador (São Paulo, id 3496): pedido SEM nenhum `include`
// (a Sportmonks já devolve tudo por omissão neste endpoint). Forma: um array de "estágios"
// (`{id, name (ex: "Regular Season", "Group Stage", "8th Finals"), rounds: [{fixtures: [...]}],
// aggregates: [{fixtures: [...]}]}`) — competições de liga usam `rounds`, competições de
// mata-mata (ex: Sudamericana) usam `aggregates` (confronto ida/volta); a MESMA fixture pode
// aparecer nos dois arrays dentro do mesmo estágio (confirmado na amostra), por isso agrupa-se por
// `id` ao juntar tudo. Cada fixture já traz `participants` com `meta.winner` (true/false/null) e
// `meta.location`, e `scores` com entradas `description: "CURRENT"` — a mesma forma já usada em
// SportmonksParticipant/SportmonksLiveScore no resto do módulo. Jogos ainda não disputados vêm com
// `result_info: null` e `scores: []`; jogos já disputados trazem os dois preenchidos — usa-se
// `result_info` (campo auto-descritivo, nunca `state_id`) para separar "já jogado" de "por jogar".
interface SportmonksScheduleFixture {
  id: number;
  starting_at: string;
  result_info?: string | null;
  participants?: SportmonksParticipant[];
  scores?: SportmonksLiveScore[];
}
interface SportmonksScheduleRound {
  fixtures?: SportmonksScheduleFixture[];
}
interface SportmonksScheduleAggregate {
  fixtures?: SportmonksScheduleFixture[];
}
interface SportmonksScheduleStage {
  id: number;
  name: string;
  rounds?: SportmonksScheduleRound[];
  aggregates?: SportmonksScheduleAggregate[];
}

async function fetchTeamSchedule(teamId: number): Promise<SportmonksScheduleStage[]> {
  const data = await sportmonksFetch<{ data: SportmonksScheduleStage[] }>(`/schedules/teams/${teamId}`);
  return data.data ?? [];
}

function flattenScheduleFixtures(stages: SportmonksScheduleStage[]): SportmonksScheduleFixture[] {
  const byId = new Map<number, SportmonksScheduleFixture>();
  for (const stage of stages) {
    for (const round of stage.rounds ?? []) for (const fixture of round.fixtures ?? []) byId.set(fixture.id, fixture);
    for (const aggregate of stage.aggregates ?? []) for (const fixture of aggregate.fixtures ?? []) byId.set(fixture.id, fixture);
  }
  return [...byId.values()];
}

export interface TeamFormMatch {
  fixtureId: number;
  date: string;
  opponent: string;
  isHome: boolean;
  result?: "V" | "E" | "D"; // só em jogos já disputados
  score?: string; // "2-1" (equipa própria primeiro), só em jogos já disputados
}

const TEAM_FORM_MATCHES_COUNT = 5;

function buildTeamForm(teamId: number, stages: SportmonksScheduleStage[]): { recent: TeamFormMatch[]; upcoming: TeamFormMatch[] } {
  const recent: TeamFormMatch[] = [];
  const upcoming: TeamFormMatch[] = [];

  for (const fixture of flattenScheduleFixtures(stages)) {
    const own = fixture.participants?.find((p) => p.id === teamId);
    const opponent = fixture.participants?.find((p) => p.id !== teamId);
    if (!own || !opponent) continue;
    const isHome = own.meta?.location === "home";

    if (fixture.result_info) {
      const currentScores = (fixture.scores ?? []).filter((s) => s.description === "CURRENT");
      const ownGoals = currentScores.find((s) => s.participant_id === teamId)?.score.goals;
      const oppGoals = currentScores.find((s) => s.participant_id === opponent.id)?.score.goals;
      let result: "V" | "E" | "D" | undefined;
      if (own.meta?.winner === true) result = "V";
      else if (opponent.meta?.winner === true) result = "D";
      else if (own.meta?.winner === false && opponent.meta?.winner === false) result = "E";
      recent.push({
        fixtureId: fixture.id,
        date: fixture.starting_at,
        opponent: opponent.name,
        isHome,
        result,
        score: ownGoals != null && oppGoals != null ? `${ownGoals}-${oppGoals}` : undefined,
      });
    } else {
      upcoming.push({ fixtureId: fixture.id, date: fixture.starting_at, opponent: opponent.name, isHome });
    }
  }

  recent.sort((a, b) => b.date.localeCompare(a.date));
  upcoming.sort((a, b) => a.date.localeCompare(b.date));
  return { recent: recent.slice(0, TEAM_FORM_MATCHES_COUNT), upcoming: upcoming.slice(0, TEAM_FORM_MATCHES_COUNT) };
}

const teamFormCache = new Map<number, { data: { recent: TeamFormMatch[]; upcoming: TeamFormMatch[] }; fetchedAt: number }>();
const TEAM_FORM_CACHE_TTL_MS = 5 * 60_000;

/** Últimos e próximos jogos de UMA equipa (Sportmonks team id), com cache curta (mesmo padrão de
 * getStandingsBySeason/getTopscorersBySeason acima). */
export async function getTeamForm(teamId: number): Promise<{ recent: TeamFormMatch[]; upcoming: TeamFormMatch[] }> {
  const cached = teamFormCache.get(teamId);
  if (cached && Date.now() - cached.fetchedAt < TEAM_FORM_CACHE_TTL_MS) return cached.data;
  const stages = await fetchTeamSchedule(teamId);
  const data = buildTeamForm(teamId, stages);
  teamFormCache.set(teamId, { data, fetchedAt: Date.now() });
  return data;
}

/** Forma recente/próximos jogos das DUAS equipas de uma fixture — resolve os IDs Sportmonks das
 * equipas (resolveTeamIds acima) e pede o calendário de cada uma em paralelo. Sem os IDs
 * resolvidos, devolve null para as duas (nunca inventa dados de outra equipa). */
export async function getTeamFormForFixture(
  fixtureId: number
): Promise<{ home: { recent: TeamFormMatch[]; upcoming: TeamFormMatch[] } | null; away: { recent: TeamFormMatch[]; upcoming: TeamFormMatch[] } | null }> {
  const teamIds = await resolveTeamIds(fixtureId);
  if (!teamIds) return { home: null, away: null };
  const [home, away] = await Promise.all([
    getTeamForm(teamIds.homeTeamId).catch(() => null),
    getTeamForm(teamIds.awayTeamId).catch(() => null),
  ]);
  return { home, away };
}

// --- Confrontos diretos / H2H (/fixtures/head-to-head/{team1}/{team2}) — CONFIRMADO por uma
// amostra real completa colada pelo utilizador (São Paulo 3496 vs Chapecoense 710). Devolve as
// fixtures mais recentes entre as duas equipas, com `participants` (meta.location/winner),
// `scores` (description "CURRENT") e `league.name` — mesmas formas já confirmadas e usadas no
// resto do módulo (SportmonksParticipant/SportmonksLiveScore/SportmonksLeague), reutilizadas tal
// como estão. A forma normalizada abaixo (HeadToHeadRow) é DE PROPÓSITO idêntica à já devolvida
// pela rota H2H da API-Football (ver routes.ts, HeadToHeadMatch em apifootball/client.ts) — o
// frontend (renderH2H() em app.js) já sabe consumir esse formato, sem precisar de nenhuma
// alteração.
interface SportmonksH2HFixture {
  id: number;
  starting_at: string;
  participants?: SportmonksParticipant[];
  scores?: SportmonksLiveScore[];
  league?: SportmonksLeague;
}

async function fetchHeadToHead(team1Id: number, team2Id: number): Promise<SportmonksH2HFixture[]> {
  const data = await sportmonksFetch<{ data: SportmonksH2HFixture[] }>(`/fixtures/head-to-head/${team1Id}/${team2Id}`, {
    include: "participants;scores;league",
  });
  return data.data ?? [];
}

export interface HeadToHeadRow {
  date: string;
  homeTeam: string;
  awayTeam: string;
  homeGoals: number | null;
  awayGoals: number | null;
  competition: string;
}

function normalizeH2HFixture(fixture: SportmonksH2HFixture): HeadToHeadRow | null {
  const home = fixture.participants?.find((p) => p.meta?.location === "home");
  const away = fixture.participants?.find((p) => p.meta?.location === "away");
  if (!home || !away) return null;
  const currentScores = (fixture.scores ?? []).filter((s) => s.description === "CURRENT");
  return {
    date: `${fixture.starting_at.trim().replace(" ", "T")}Z`,
    homeTeam: home.name,
    awayTeam: away.name,
    homeGoals: currentScores.find((s) => s.participant_id === home.id)?.score.goals ?? null,
    awayGoals: currentScores.find((s) => s.participant_id === away.id)?.score.goals ?? null,
    competition: fixture.league?.name ?? "Futebol",
  };
}

const h2hCache = new Map<string, { rows: HeadToHeadRow[]; fetchedAt: number }>();
const H2H_CACHE_TTL_MS = 5 * 60_000;

async function getHeadToHeadCached(team1Id: number, team2Id: number): Promise<HeadToHeadRow[]> {
  const key = [team1Id, team2Id].sort((a, b) => a - b).join(":");
  const cached = h2hCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < H2H_CACHE_TTL_MS) return cached.rows;
  const fixtures = await fetchHeadToHead(team1Id, team2Id);
  const rows = fixtures
    .map(normalizeH2HFixture)
    .filter((r): r is HeadToHeadRow => r !== null)
    .sort((a, b) => b.date.localeCompare(a.date));
  h2hCache.set(key, { rows, fetchedAt: Date.now() });
  return rows;
}

/** Confrontos diretos das duas equipas de uma fixture — resolve os IDs Sportmonks (resolveTeamIds
 * acima) e pede o histórico entre elas. Sem os IDs resolvidos, devolve lista vazia (nunca inventa
 * confrontos). */
export async function getHeadToHeadForFixture(fixtureId: number, limit = 5): Promise<HeadToHeadRow[]> {
  const teamIds = await resolveTeamIds(fixtureId);
  if (!teamIds) return [];
  const rows = await getHeadToHeadCached(teamIds.homeTeamId, teamIds.awayTeamId);
  return rows.slice(0, limit);
}
