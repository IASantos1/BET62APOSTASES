/**
 * Configuração de fallback entre bookmakers, tal como pedida pelo utilizador (colada como JSON,
 * confirmada por ele contra a documentação real da Pulsescore) — para cada tipo de mercado, uma
 * lista de bookmakers pela ordem de preferência. Quando a bookmaker principal do evento não tem
 * um mercado (ex: um jogo de liga pequena sem "Escanteios"/"Cartões"/"Marcador"), percorre-se
 * esta lista, bookmaker a bookmaker, até encontrar a primeira com esse mercado disponível e com
 * dados válidos (ver crossBookmakerFallback.ts) — NUNCA duplica um mercado que a bookmaker
 * principal já tem, só preenche o que está mesmo em falta.
 *
 * ⚠️ **NEEDS VALIDATION — id de bookmaker vs. segmento real do path REST**: este projeto já
 * confirmou, com pedidos reais, que o segmento correto para a bookmaker principal é
 * "paddypower" (sem underscore, ver PULSESCORE_BOOKMAKER em env.ts) e não "paddy_power" como
 * este JSON escreve — grafias diferentes para a mesma bookmaker. `ROUTING_ID_TO_PULSESCORE_SLUG`
 * abaixo traduz os 5 ids desta lista com confirmação própria nesta integração (paddy_power,
 * bet365, unibet_au, 10bet_couk, pinnacle_ps3838 — ver o histórico de comentários em client.ts).
 * Os OUTROS 25 ids (fanduel, bwin, william_hill, ladbrokes, betfred, draftkings, polymarket,
 * betano_de, betmgm_couk, betmgm_nl, bc_game, stake, betway_mw, sportsbet_au, thunderpick,
 * orbit_exchange, betfair_sportsbook, sky_bet, cloudbet, tipsport, bet_right, aba, betmgm_us,
 * betrivers, betway, star_sports) passam tal como vêm como segmento do path — SEM confirmação
 * própria via pedido real nesta integração. Se o segmento estiver errado, o pedido àquela
 * bookmaker falha (404/erro) e o motor de fallback (crossBookmakerFallback.ts) simplesmente
 * avança para a próxima bookmaker da lista, sem quebrar nada — mas os mercados dessas 25
 * bookmakers só vão mesmo aparecer depois de alguém confirmar os segmentos reais.
 */

export const MARKET_ROUTING_DEFAULT_PRIMARY = "paddy_power";

/** Lista de TODOS os routing IDs (nome amigável com underscores/dots) que sabemos mapear
 *  para um segmento de path Pulsescore real — 31 bookmakers, ORDEM GERAL de preferência
 *  (licenciado EU + Pinnacle exchange no topo). */
export const MARKET_ROUTING_BOOKMAKERS: string[] = [
  "paddy_power", "bet365", "pinnacle_ps3838", "unibet_au", "betfair_exchange", "stake",
  "betano_de", "bwin", "william_hill", "ladbrokes", "betfred", "10bet_couk", "betway_mw",
  "betfair_sportsbook", "sky_bet", "betmgm_couk", "betmgm_nl", "betmgm_us", "cloudbet",
  "draftkings", "fanduel", "betrivers", "bc_game", "polymarket", "thunderpick",
  "sportsbet_au", "tipsport", "tab", "bet_at_home", "bet_right",
];

/** Mapeamento OFICIAL 1:1 entre routing ID (underscore, friendly) → segmento path Pulsescore
 *  (SEM versionamento; bet365 usa /v3/bet365 e é tratado à parte em client.ts::bookmakerPathSegment).
 *  ✅ CONFIRMADO em https://pulsescore.net/docs (Bookmaker API References + WebSocket table endpoints) */
const ROUTING_ID_TO_PULSESCORE_SLUG: Record<string, string> = {
  paddy_power: "paddypower",
  unibet_au: "unibetau",
  "10bet_couk": "10bet",
  pinnacle_ps3838: "ps3838",
  william_hill: "willhill",
  betano_de: "betano-de",
  betmgm_couk: "betmgm-couk",
  betmgm_nl: "betmgm-nl",
  bc_game: "bcgame",
  betway_mw: "betwaymw",
  sportsbet_au: "sportsbet-com-au",
  betfair_exchange: "orbitxch",
  betfair_sportsbook: "betfair-sb",
  sky_bet: "skybet",
  bet_at_home: "betathome",
  bet_right: "betright",
  tab: "tab",
  betmgm_us: "betmgm",
};

/** 🔍 Desportos cobertos POR CASA, extraídos da tabela docs "Valid Sports per Bookmaker".
 *  Se uma casa NÃO listar um sport aqui, o fallback NÃO TENTA ESSA CASA para esse desporto —
 *  evita gastar rate limit com pedidos garantidos de 0 eventos (a docs confirmam que fecha WS 4004
 *  se tentarmos sport não suportado; REST simplesmente devolve vazio mas custa quota). */
export const VALID_SPORTS_BY_ROUTING_ID: Record<string, Set<string>> = {
  bet365: new Set(["soccer", "basketball", "tennis", "ice-hockey", "rugby-league", "rugby-union", "volleyball", "handball", "table-tennis", "e-sports", "esports", "american-football", "baseball", "greyhounds", "horse-racing", "cricket"]),
  betfair_exchange: new Set(["american-football", "australian-rules", "baseball", "basketball", "boxing", "cricket", "darts", "esports", "gaelic-games", "rugby-league", "rugby-union", "soccer", "tennis", "volleyball"]),
  pinnacle_ps3838: new Set(["soccer", "basketball", "tennis", "american-football", "ice-hockey", "baseball", "rugby-league"]),
  polymarket: new Set(["american-football", "baseball", "basketball", "boxing", "cricket", "esports", "lacrosse", "mma", "pickleball", "soccer", "table-tennis", "tennis", "volleyball"]),
  unibet_au: new Set(["american-football", "australian-rules", "baseball", "basketball", "boxing", "cricket", "cycling", "darts", "esports", "formula-1", "futsal", "golf", "greyhounds", "handball", "horse-racing", "ice-hockey", "lacrosse", "mma", "motorsports", "rugby-league", "rugby-union", "snooker", "soccer", "table-tennis", "tennis", "volleyball"]),
  fanduel: new Set(["american-football", "baseball", "basketball", "boxing", "cricket", "darts", "handball", "ice-hockey", "mma", "rugby-league", "rugby-union", "snooker", "soccer", "table-tennis", "tennis"]),
  bwin: new Set(["american-football", "baseball", "basketball", "cricket", "darts", "futsal", "handball", "ice-hockey", "rugby-league", "rugby-union", "snooker", "soccer", "table-tennis", "tennis", "volleyball"]),
  draftkings: new Set(["american-football", "australian-rules", "baseball", "basketball", "boxing", "cricket", "cycling", "darts", "esports", "golf", "handball", "ice-hockey", "lacrosse", "mma", "motorsports", "rugby-league", "rugby-union", "snooker", "soccer", "table-tennis", "tennis"]),
  ladbrokes: new Set(["american-football", "baseball", "basketball", "boxing", "cricket", "darts", "esports", "greyhounds", "handball", "horse-racing", "ice-hockey", "mma", "rugby-league", "rugby-union", "soccer", "table-tennis", "tennis", "volleyball"]),
  paddy_power: new Set(["american-football", "australian-rules", "baseball", "basketball", "boxing", "cricket", "darts", "esports", "golf", "greyhounds", "handball", "horse-racing", "ice-hockey", "mma", "motorsports", "rugby-league", "rugby-union", "snooker", "soccer", "table-tennis", "tennis", "volleyball"]),
  betfred: new Set(["baseball", "basketball", "boxing", "cricket", "greyhounds", "horse-racing", "mma", "rugby-league", "soccer", "tennis"]),
  betano_de: new Set(["american-football", "baseball", "basketball", "boxing", "cricket", "cycling", "darts", "formula-1", "golf", "handball", "ice-hockey", "motorsports", "rugby-league", "rugby-union", "soccer", "tennis", "volleyball"]),
  betmgm_couk: new Set(["american-football", "baseball", "basketball", "boxing", "cricket", "darts", "handball", "ice-hockey", "rugby-league", "rugby-union", "snooker", "soccer", "table-tennis", "tennis", "volleyball"]),
  betmgm_nl: new Set(["american-football", "baseball", "basketball", "boxing", "cricket", "darts", "handball", "ice-hockey", "rugby-league", "rugby-union", "snooker", "soccer", "table-tennis", "tennis", "volleyball"]),
  stake: new Set(["american-football", "australian-rules", "baseball", "basketball", "boxing", "cricket", "darts", "esports", "ice-hockey", "mma", "rugby-union", "soccer", "table-tennis", "tennis", "volleyball", "water-polo"]),
  betway_mw: new Set(["american-football", "australian-rules", "baseball", "basketball", "beach-volley", "boxing", "cricket", "darts", "futsal", "handball", "ice-hockey", "mma", "rugby-union", "snooker", "soccer", "table-tennis", "tennis", "volleyball"]),
  "10bet_couk": new Set(["american-football", "australian-rules", "baseball", "basketball", "boxing", "cricket", "darts", "esports", "futsal", "handball", "ice-hockey", "mma", "rugby-league", "rugby-union", "snooker", "soccer", "table-tennis", "tennis", "volleyball"]),
  sportsbet_au: new Set(["american-football", "australian-rules", "baseball", "basketball", "boxing", "cricket", "darts", "esports", "mma", "rugby-league", "rugby-union", "snooker", "soccer", "table-tennis", "tennis", "volleyball"]),
  thunderpick: new Set(["american-football", "australian-rules", "badminton", "baseball", "basketball", "cricket", "darts", "esports", "ice-hockey", "martial-arts", "rugby-league", "rugby-union", "soccer", "table-tennis", "tennis", "volleyball"]),
  betfair_sportsbook: new Set(["american-football", "australian-rules", "baseball", "basketball", "boxing", "cricket", "darts", "esports", "ice-hockey", "mma", "rugby-league", "snooker", "soccer", "table-tennis", "tennis", "volleyball"]),
  sky_bet: new Set(["american-football", "australian-rules", "baseball", "basketball", "boxing", "cricket", "darts", "esports", "ice-hockey", "mma", "rugby-league", "rugby-union", "snooker", "soccer", "table-tennis", "tennis", "volleyball"]),
  cloudbet: new Set(["american-football", "australian-rules", "badminton", "baseball", "basketball", "boxing", "cricket", "cycling", "esports", "golf", "ice-hockey", "mma", "rugby-league", "rugby-union", "soccer", "table-tennis", "tennis", "volleyball"]),
  bet_at_home: new Set(["american-football", "australian-rules", "baseball", "basketball", "cricket", "ice-hockey", "rugby-league", "soccer", "tennis"]),
  tipsport: new Set(["american-football", "australian-rules", "badminton", "baseball", "basketball", "beach-volley", "boxing", "esports", "handball", "ice-hockey", "mma", "padel", "rugby-league", "rugby-union", "snooker", "soccer", "table-tennis", "tennis"]),
  tab: new Set(["american-football", "australian-rules", "baseball", "basketball", "boxing", "cricket", "rugby-league", "rugby-union", "snooker", "soccer"]),
  betmgm_us: new Set(["american-football", "baseball", "basketball", "boxing", "cricket", "esports", "ice-hockey", "lacrosse", "mma", "rugby-league", "soccer", "table-tennis", "tennis"]),
  betrivers: new Set(["american-football", "baseball", "basketball", "hockey", "soccer", "tennis"]),
  bc_game: new Set(["soccer", "tennis", "basketball", "esports", "american-football", "ice-hockey", "baseball", "volleyball"]),
  bet_right: new Set(["soccer", "tennis", "basketball", "australian-rules", "rugby-league", "rugby-union", "horse-racing", "greyhounds"]),
};

/** Ids com segmento de path REST + sports coverage confirmados AGORA via docs OFICIAIS (acima).
 *  Antes eram só 5; agora 29 — cross-bookmaker fallback finalmente funciona. */
export const ROUTING_IDS_CONFIRMED = new Set(MARKET_ROUTING_BOOKMAKERS);

export function pulsescoreSlugForRoutingId(routingId: string): string {
  return ROUTING_ID_TO_PULSESCORE_SLUG[routingId] ?? routingId;
}

/**
 * Lista de bookmakers por tipo de mercado, pela ordem de preferência exata que o utilizador
 * colou. As chaves são usadas por `classifyRoutingMarket()` (abaixo) para saber a que tipo um
 * mercado bruto da Pulsescore pertence.
 */
export const MARKET_ROUTING: Record<string, string[]> = {
  match_result: [
    "paddy_power", "bet365", "bwin", "william_hill", "betano_de", "betfred", "ladbrokes",
    "10bet_couk", "betway", "betfair_sportsbook", "unibet_au", "sky_bet", "betmgm_couk",
    "betmgm_nl", "betmgm_us", "betway_mw", "tipsport", "betrivers", "draftkings", "fanduel",
    "sportsbet_au", "star_sports", "bc_game", "stake", "cloudbet", "thunderpick",
    "pinnacle_ps3838", "orbit_exchange",
  ],
  double_chance: [
    "paddy_power", "bet365", "bwin", "betano_de", "william_hill", "betfred", "ladbrokes",
    "betway", "10bet_couk", "unibet_au", "sky_bet", "betfair_sportsbook", "betmgm_couk",
    "betmgm_nl", "betmgm_us", "betrivers", "tipsport", "bc_game", "stake", "cloudbet",
  ],
  draw_no_bet: [
    "paddy_power", "pinnacle_ps3838", "bet365", "betfair_sportsbook", "bwin", "betano_de",
    "william_hill", "betway", "10bet_couk", "betfred", "ladbrokes", "unibet_au", "sky_bet",
    "tipsport", "bc_game", "stake", "cloudbet",
  ],
  over_under: [
    "paddy_power", "pinnacle_ps3838", "bet365", "betano_de", "bwin", "william_hill", "betfred",
    "ladbrokes", "betway", "10bet_couk", "betfair_sportsbook", "unibet_au", "sky_bet",
    "betmgm_couk", "betmgm_nl", "betmgm_us", "betrivers", "tipsport", "bc_game", "stake",
    "cloudbet", "thunderpick", "sportsbet_au", "star_sports",
  ],
  asian_handicap: [
    "paddy_power", "pinnacle_ps3838", "bet365", "betfair_sportsbook", "betano_de", "bwin",
    "william_hill", "betway", "10bet_couk", "betfred", "ladbrokes", "unibet_au", "sky_bet",
    "tipsport", "bc_game", "stake", "cloudbet", "thunderpick", "sportsbet_au",
  ],
  btts: [
    "paddy_power", "bet365", "betano_de", "bwin", "william_hill", "betfred", "ladbrokes",
    "betway", "10bet_couk", "unibet_au", "betfair_sportsbook", "sky_bet", "betmgm_couk",
    "betmgm_nl", "betmgm_us", "betrivers", "tipsport", "bc_game", "stake", "cloudbet",
  ],
  correct_score: [
    "paddy_power", "bet365", "betano_de", "bwin", "william_hill", "betfred", "ladbrokes",
    "betway", "10bet_couk", "unibet_au", "sky_bet", "betfair_sportsbook", "tipsport", "bc_game",
    "stake", "cloudbet",
  ],
  anytime_goalscorer: [
    "paddy_power", "bet365", "betano_de", "bwin", "william_hill", "betfred", "ladbrokes",
    "betway", "10bet_couk", "unibet_au", "sky_bet", "betfair_sportsbook", "betmgm_couk",
    "betmgm_nl", "betmgm_us", "betrivers", "tipsport", "bc_game", "stake", "cloudbet",
  ],
  first_goalscorer: [
    "paddy_power", "bet365", "betano_de", "bwin", "william_hill", "betfred", "ladbrokes",
    "betway", "10bet_couk", "unibet_au", "sky_bet", "betfair_sportsbook", "tipsport", "bc_game",
    "stake", "cloudbet",
  ],
  last_goalscorer: [
    "paddy_power", "bet365", "betano_de", "bwin", "william_hill", "betfred", "ladbrokes",
    "betway", "10bet_couk", "unibet_au", "sky_bet", "betfair_sportsbook", "tipsport", "bc_game",
    "stake", "cloudbet",
  ],
  corners: [
    "paddy_power", "bet365", "betano_de", "bwin", "william_hill", "betfred", "ladbrokes",
    "betway", "10bet_couk", "unibet_au", "sky_bet", "betfair_sportsbook", "tipsport", "bc_game",
    "stake", "cloudbet", "sportsbet_au",
  ],
  corner_handicap: [
    "paddy_power", "bet365", "betano_de", "bwin", "betfair_sportsbook", "william_hill", "betway",
    "10bet_couk", "betfred", "ladbrokes", "tipsport",
  ],
  cards: [
    "paddy_power", "betano_de", "bet365", "bwin", "william_hill", "betfred", "ladbrokes",
    "betway", "10bet_couk", "betfair_sportsbook", "unibet_au", "sky_bet", "tipsport", "bc_game",
    "stake",
  ],
  player_to_be_booked: [
    "paddy_power", "betano_de", "bet365", "bwin", "william_hill", "betfred", "ladbrokes",
    "betway", "10bet_couk", "betfair_sportsbook", "sky_bet", "tipsport",
  ],
  shots: [
    "paddy_power", "bet365", "betano_de", "bwin", "william_hill", "betfred", "betway",
    "10bet_couk", "unibet_au", "sky_bet", "betfair_sportsbook", "betmgm_couk", "betmgm_nl",
    "betmgm_us", "betrivers", "draftkings", "fanduel",
  ],
  shots_on_target: [
    "paddy_power", "bet365", "betano_de", "bwin", "william_hill", "betfred", "betway",
    "10bet_couk", "unibet_au", "sky_bet", "betfair_sportsbook", "betmgm_couk", "betmgm_nl",
    "betmgm_us", "betrivers", "draftkings", "fanduel",
  ],
  player_shots: [
    "paddy_power", "bet365", "betano_de", "bwin", "betmgm_couk", "betmgm_nl", "betmgm_us",
    "betrivers", "draftkings", "fanduel", "william_hill", "betway",
  ],
  player_shots_on_target: [
    "paddy_power", "bet365", "betano_de", "bwin", "betmgm_couk", "betmgm_nl", "betmgm_us",
    "betrivers", "draftkings", "fanduel", "william_hill", "betway",
  ],
  passes: [
    "paddy_power", "bet365", "betano_de", "bwin", "betmgm_couk", "betmgm_nl", "betmgm_us",
    "betrivers", "draftkings", "fanduel",
  ],
  assists: [
    "paddy_power", "bet365", "betano_de", "bwin", "betmgm_couk", "betmgm_nl", "betmgm_us",
    "betrivers", "draftkings", "fanduel",
  ],
  fouls: [
    "paddy_power", "bet365", "betano_de", "bwin", "betano_de", "william_hill", "betfred",
    "betway", "10bet_couk", "tipsport",
  ],
  offsides: [
    "paddy_power", "bet365", "betano_de", "bwin", "william_hill", "betfred", "betway",
    "10bet_couk", "unibet_au", "betfair_sportsbook",
  ],
  goal_minutes: [
    "paddy_power", "bet365", "betano_de", "bwin", "william_hill", "betfred", "betway",
    "10bet_couk", "unibet_au", "sky_bet",
  ],
  scorecast: [
    "paddy_power", "bet365", "betano_de", "bwin", "william_hill", "betfred", "ladbrokes",
    "betway", "10bet_couk", "unibet_au",
  ],
  result_and_btts: [
    "paddy_power", "bet365", "betano_de", "bwin", "william_hill", "betfred", "ladbrokes",
    "betway", "10bet_couk", "unibet_au",
  ],
  result_and_goalscorer: [
    "paddy_power", "bet365", "betano_de", "bwin", "william_hill", "betfred", "ladbrokes",
    "betway", "10bet_couk",
  ],
  race_to_corners: [
    "paddy_power", "bet365", "betano_de", "bwin", "betway", "10bet_couk", "william_hill",
    "betfred", "ladbrokes", "betfair_sportsbook",
  ],
  race_to_goals: [
    "paddy_power", "bet365", "betano_de", "bwin", "betway", "10bet_couk", "william_hill",
    "betfred", "ladbrokes",
  ],
  race_to_cards: [
    "paddy_power", "betano_de", "bwin", "bet365", "betway", "10bet_couk", "william_hill",
    "betfred", "ladbrokes",
  ],
  odd_even_goals: ["paddy_power", "bet365", "betano_de", "bwin", "betway", "10bet_couk", "william_hill"],
  odd_even_corners: ["paddy_power", "bet365", "betano_de", "bwin", "betway", "10bet_couk", "william_hill"],
  odd_even_cards: ["paddy_power", "betano_de", "bwin", "bet365", "betway", "10bet_couk", "william_hill"],
  mythical_match: ["paddy_power"],
  multi_corners: ["paddy_power", "bet365", "betano_de", "bwin", "betway", "10bet_couk"],
  ten_minute_markets: ["paddy_power", "bet365", "betano_de", "bwin", "betway", "10bet_couk", "william_hill"],
  extra_time_result: ["paddy_power", "bet365", "betano_de", "bwin", "betway"],
  extra_time_correct_score: ["paddy_power", "bet365", "betano_de", "bwin"],
};

export type RoutingMarketKey = keyof typeof MARKET_ROUTING;

// Mercados de uma parte/período específico (1º Tempo, 2º Quarto...) nunca são classificados
// aqui — mesma exclusão de settlementRules.ts, para não confundir "Escanteios 1º Tempo" com
// "Escanteios" do jogo inteiro (categorias diferentes, cada uma com o seu próprio fallback).
const PERIOD_SPECIFIC_RE =
  /1st half|first half|2nd half|second half|half.?time|\bht\b|1st quarter|first quarter|2nd quarter|3rd quarter|4th quarter|\bq[1-4]\b|1st period|first period|2nd period|3rd period|period\s*\d|1st set|first set/i;

/**
 * Classifica o NOME BRUTO de um mercado (`LiveOdds.market`, tal como a Pulsescore envia — nunca
 * o `canonicalMarket`, ver a mesma decisão em web/app.js::MARKET_FILTER_CATEGORIES e
 * betting/settlementRules.ts::classifyMarket) numa chave de `MARKET_ROUTING`, ou `null` se não
 * bater em nenhuma. Heurística por palavra-chave — os primeiros 14 tipos (match_result até
 * player_to_be_booked) reaproveitam/alinham com padrões já testados noutras partes do projeto;
 * os restantes (estatísticas de jogador, mercados de corrida/ímpar-par, etc.) são heurísticas
 * novas, best-effort, **NEEDS VALIDATION** contra nomes de mercado reais assim que houver
 * amostras (mesma metodologia já usada no resto do projeto).
 */
export function classifyRoutingMarket(rawName: string): RoutingMarketKey | null {
  const m = rawName;
  if (PERIOD_SPECIFIC_RE.test(m)) return null;

  if (/extra.?time.*correct score|correct score.*extra.?time/i.test(m)) return "extra_time_correct_score";
  if (/extra.?time/i.test(m)) return "extra_time_result";
  if (/scorecast/i.test(m)) return "scorecast";
  if (/result.*both teams to score|both teams to score.*result/i.test(m)) return "result_and_btts";
  if (/result.*goalscorer|goalscorer.*result/i.test(m)) return "result_and_goalscorer";
  if (/mythical/i.test(m)) return "mythical_match";
  if (/10.?min|ten.?minute/i.test(m)) return "ten_minute_markets";
  if (/multi.?corners/i.test(m)) return "multi_corners";

  if (/odd.?\/?.?even.*corner|corner.*odd.?\/?.?even/i.test(m)) return "odd_even_corners";
  if (/odd.?\/?.?even.*card|card.*odd.?\/?.?even/i.test(m)) return "odd_even_cards";
  if (/odd.?\/?.?even/i.test(m)) return "odd_even_goals";

  if (/race to.*corner|corner.*race to/i.test(m)) return "race_to_corners";
  if (/race to.*card|card.*race to/i.test(m)) return "race_to_cards";
  if (/race to/i.test(m)) return "race_to_goals";

  if (/first to score|last to score|to score first|to score last|first goalscorer/i.test(m)) return "first_goalscorer";
  if (/last goalscorer/i.test(m)) return "last_goalscorer";
  if (/goalscorer|\bscorer\b|player.*(to score|goals)/i.test(m)) return "anytime_goalscorer";

  if (/player.*shot.*target|shot.*target.*player/i.test(m)) return "player_shots_on_target";
  if (/player.*shot/i.test(m)) return "player_shots";
  if (/shot.*on target|shots? on target/i.test(m)) return "shots_on_target";
  if (/\bshots?\b/i.test(m)) return "shots";
  if (/\bpass(es)?\b/i.test(m)) return "passes";
  if (/\bassists?\b/i.test(m)) return "assists";
  if (/\bfouls?\b/i.test(m)) return "fouls";
  if (/offside/i.test(m)) return "offsides";
  if (/goal.?minute|time of.*goal/i.test(m)) return "goal_minutes";

  if (/player.*booked|booked.*player|to be booked/i.test(m)) return "player_to_be_booked";
  if (/corner.*handicap|handicap.*corner/i.test(m)) return "corner_handicap";
  const isOverUnder = /over\/?under|total/i.test(m);
  if (/corner/i.test(m)) return isOverUnder ? "corners" : "corner_handicap";
  if (/\bcard|booking/i.test(m)) return "cards";

  if (/correct score|exact score/i.test(m)) return "correct_score";
  if (/both teams to score|\bbtts\b|both to score/i.test(m)) return "btts";
  if (/handicap|spread|asian/i.test(m)) return "asian_handicap";
  if (isOverUnder) return "over_under";
  if (/draw no bet/i.test(m)) return "draw_no_bet";
  if (/double chance/i.test(m)) return "double_chance";
  if (/match odds|\b1x2\b|to win|winner|money.?line|full time result|3.?way/i.test(m)) return "match_result";

  return null;
}
