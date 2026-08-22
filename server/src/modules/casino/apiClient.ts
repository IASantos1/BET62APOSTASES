import { env } from "../../config/env";
import { logger } from "../../lib/logger";
import { Errors } from "../../lib/errors";

// Cliente da Agent API do goldslotpalase.com (Cassino Gold Palace). Reconstruído do zero após a
// remoção anterior — só implementa endpoints confirmados ao vivo pelo utilizador (curl real,
// resposta real), um de cada vez, em vez de assumir o contrato do Swagger antigo. Ver
// docs/CASINO_SLOTS.md para o histórico. Todos os pedidos confirmados até agora são POST sob
// /v4/..., autenticados por "Authorization: Bearer {CASINO_AGENT_KEY}", com corpo/resposta JSON.

function assertConfigured() {
  if (!env.CASINO_AGENT_KEY) {
    throw Errors.badRequest("Cassino: CASINO_AGENT_KEY não configurada neste ambiente.");
  }
}

interface AgentApiResult<T> {
  code: number;
  message: string | null;
  data: T;
}

async function postAgent<T>(path: string, body: Record<string, unknown> = {}): Promise<AgentApiResult<T>> {
  assertConfigured();
  const url = `${env.CASINO_PROVIDER_BASE_URL}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CASINO_AGENT_KEY}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    logger.warn({ status: res.status, path, body: text.slice(0, 300) }, "Cassino: pedido à Agent API falhou");
    throw Errors.internal(`Cassino devolveu ${res.status} para ${path}`);
  }

  const json = (await res.json()) as AgentApiResult<T>;
  if (json.code !== 0) {
    logger.warn({ path, code: json.code, message: json.message }, "Cassino: Agent API devolveu um código de erro");
    throw Errors.badRequest(`Cassino: ${json.message ?? `código de erro ${json.code}`}`, { code: json.code });
  }
  return json;
}

export interface AgentInfo {
  name: string;
  currency: number;
  balance: number;
  rtp: number;
  whitelist?: string[];
  client_ip?: string;
}

/** Confirmado: POST /v4/agent/info — devolve saldo, currency, whitelist e client_ip do agente. */
export async function getAgentInfo(): Promise<AgentInfo> {
  const res = await postAgent<AgentInfo>("/v4/agent/info");
  return res.data;
}

/** Confirmado: POST /v4/agent/rtp — define o RTP por omissão do agente ({@code 0} = RTP do provedor). */
export async function setAgentRtp(rtp: number): Promise<void> {
  await postAgent("/v4/agent/rtp", { rtp });
}

export interface CallbackTestResult {
  callbackUrl: string;
  time: string;
}

/**
 * Confirmado: POST /v4/agent/callback-test — o provedor testa, a partir da rede dele, se
 * consegue alcançar o URL de callback configurado no painel do agente e devolve o URL testado
 * mais o tempo de resposta. Útil para confirmar conectividade sem depender de lançar um jogo
 * real (era exatamente isto que falhava silenciosamente na integração anterior).
 */
export async function testCallback(): Promise<CallbackTestResult> {
  const res = await postAgent<{ callback_url: string; time: string }>("/v4/agent/callback-test");
  return { callbackUrl: res.data.callback_url, time: res.data.time };
}

/**
 * Confirmado: POST /v4/user/info — consulta uma conta já criada no provedor por `user_code`.
 * Só se confirmou até agora o caso de erro (`USER_NOT_FOUND`, código 2002, propagado por
 * postAgent()); a forma exata do `data` de sucesso ainda não foi vista, por isso devolve-se sem
 * tipar os campos em vez de inventar uma forma.
 */
export async function getUserInfo(userCode: number): Promise<unknown> {
  const res = await postAgent("/v4/user/info", { user_code: userCode });
  return res.data;
}

export interface GameProvider {
  providerId: number;
  providerName: string;
  localeName: string;
  status: number;
}

/**
 * Confirmado: POST /v4/game/providers — lista os provedores de jogos disponíveis (Pragmatic
 * Play, CQ9, etc). `status` confirmado com os valores 1 e 2 na resposta real; o significado de
 * cada valor não foi confirmado ainda (assumir "1 = ativo" só quando confirmado).
 */
export async function getGameProviders(lang = 1): Promise<GameProvider[]> {
  const res = await postAgent<Array<{ provider_id: number; provider_name: string; locale_name: string; status: number }>>(
    "/v4/game/providers",
    { lang }
  );
  return res.data.map((p) => ({ providerId: p.provider_id, providerName: p.provider_name, localeName: p.locale_name, status: p.status }));
}

export interface CasinoGame {
  providerId: number;
  gameCode: string;
  gameName: string;
  localeName: string;
  gameImage: string;
  gameImageNarrow: string;
  launchEnable: boolean;
  category: string;
  regDate: string;
}

/**
 * Confirmado: POST /v4/game/games — lista o catálogo de jogos de um provedor (testado com
 * provider_id 1 = Pragmatic Play: mais de 500 jogos devolvidos, todos category "Slots",
 * launch_enable true). Devolve os campos tal como confirmados na resposta real, sem inventar
 * nenhum adicional.
 */
export async function getGames(providerId: number, lang = 1): Promise<CasinoGame[]> {
  const res = await postAgent<
    Array<{
      provider_id: number;
      game_code: string;
      game_name: string;
      locale_name: string;
      game_image: string;
      game_image_narrow: string;
      launch_enable: boolean;
      category: string;
      reg_date: string;
    }>
  >("/v4/game/games", { provider_id: providerId, lang });
  return res.data.map((g) => ({
    providerId: g.provider_id,
    gameCode: g.game_code,
    gameName: g.game_name,
    localeName: g.locale_name,
    gameImage: g.game_image,
    gameImageNarrow: g.game_image_narrow,
    launchEnable: g.launch_enable,
    category: g.category,
    regDate: g.reg_date,
  }));
}

/**
 * Confirmado: POST /v4/game/all — lista o catálogo completo de jogos de todos os provedores
 * numa só chamada (sem provider_id), a mesma forma de item que /v4/game/games. Confirmado com
 * provedores até provider_id 40 na resposta real.
 */
export async function getAllGames(lang = 1): Promise<CasinoGame[]> {
  const res = await postAgent<
    Array<{
      provider_id: number;
      game_code: string;
      game_name: string;
      locale_name: string;
      game_image: string;
      game_image_narrow: string;
      launch_enable: boolean;
      category: string;
      reg_date: string;
    }>
  >("/v4/game/all", { lang });
  return res.data.map((g) => ({
    providerId: g.provider_id,
    gameCode: g.game_code,
    gameName: g.game_name,
    localeName: g.locale_name,
    gameImage: g.game_image,
    gameImageNarrow: g.game_image_narrow,
    launchEnable: g.launch_enable,
    category: g.category,
    regDate: g.reg_date,
  }));
}

export interface LaunchGameOptions {
  userCode: number;
  providerId: number;
  gameSymbol: string;
  lang?: number;
  returnUrl?: string;
  rtp?: number;
  isFinishJackpot?: boolean;
}

/**
 * Confirmado: POST /v4/game/game-url — pedido testado com um user_code inexistente, devolveu
 * `USER_NOT_FOUND` (código 2002) propagado por postAgent(), confirmando o formato do corpo
 * (user_code, provider_id, game_symbol, lang, return_url, rtp, is_finish_jackpot). A forma exata
 * do `data` de sucesso (o URL de lançamento) ainda não foi vista — bloqueado por `user/create`
 * ainda não funcionar (ver docs/CASINO_SLOTS.md) — por isso devolve-se sem tipar os campos em
 * vez de inventar uma forma.
 */
export async function launchGame(options: LaunchGameOptions): Promise<unknown> {
  const res = await postAgent("/v4/game/game-url", {
    user_code: options.userCode,
    provider_id: options.providerId,
    game_symbol: options.gameSymbol,
    lang: options.lang ?? 1,
    return_url: options.returnUrl ?? "",
    rtp: options.rtp ?? 0,
    is_finish_jackpot: options.isFinishJackpot ?? true,
  });
  return res.data;
}

/**
 * Confirmado: POST /v4/game/online-games — devolveu `data: []` (nenhum jogador em jogo agora,
 * esperado — ninguém ainda conseguiu lançar um jogo de verdade). A forma de cada item da lista
 * ainda não foi vista, por isso devolve-se sem tipar os campos em vez de inventar uma forma.
 */
export async function getOnlineGames(): Promise<unknown[]> {
  const res = await postAgent<unknown[]>("/v4/game/online-games");
  return res.data;
}

export interface CallConfig {
  callMin: number;
}

/**
 * Confirmado: POST /v4/game/call_config — devolveu `{ call_min: 10 }`. O significado exato de
 * `call_min` (ex: intervalo mínimo entre chamadas ao provedor, aposta mínima) ainda não foi
 * confirmado — só se guarda o campo tal como veio, sem lhe atribuir um significado.
 */
export async function getCallConfig(): Promise<CallConfig> {
  const res = await postAgent<{ call_min: number }>("/v4/game/call_config");
  return { callMin: res.data.call_min };
}

export interface CallStartOptions {
  gplayId: number;
  setPoint: number;
  type: number;
  memo?: string;
}

/**
 * Confirmado: POST /v4/game/call_start — pedido testado com `{ gplay_id: 0, set_point: 0,
 * type: 0, memo: "string" }`, devolveu `PERMISSION_ERROR` (código 1010) propagado por
 * postAgent() — diferente do USER_NOT_FOUND visto noutros endpoints, por isso parece precisar
 * de mais do que só um user_code válido (ex: uma sessão de jogo ativa, ou um `gplay_id` real em
 * vez de 0). A forma exata do `data` de sucesso e o significado de cada campo (gplay_id,
 * set_point, type) ainda não foram confirmados — só se implementa o formato do corpo já visto,
 * sem inventar o resto.
 */
export async function callStart(options: CallStartOptions): Promise<unknown> {
  const res = await postAgent("/v4/game/call_start", {
    gplay_id: options.gplayId,
    set_point: options.setPoint,
    type: options.type,
    memo: options.memo ?? "",
  });
  return res.data;
}

/**
 * Confirmado: POST /v4/game/call_cancel — pedido testado com `{ call_id: 0 }`, devolveu
 * `RESOURCE_NOT_FOUND` (código 1005) propagado por postAgent() — esperado, `call_id 0` nunca
 * existiu (call_start nunca chegou a criar um call_id de verdade). Forma de sucesso ainda não
 * vista.
 */
export async function callCancel(callId: number): Promise<unknown> {
  const res = await postAgent("/v4/game/call_cancel", { call_id: callId });
  return res.data;
}

export interface CreateFreeroundOptions {
  userCode: number;
  providerId: number;
  gameSymbol: string;
  bet: number;
  win: number;
  rounds: number;
  /** epoch em milissegundos — o provedor exige pelo menos 30 minutos no futuro (confirmado). */
  expirationDate: number;
}

/**
 * Confirmado: POST /v4/game/freeround/create — pedido testado com `expirationDate: 0`, devolveu
 * um erro de validação (código 1002): "[expirationDate] must be at least 30 minutes from now"
 * — confirma que `expirationDate` é um epoch em milissegundos e que o provedor exige pelo menos
 * 30 minutos no futuro. Forma exata do `data` de sucesso ainda não vista.
 */
export async function createFreeround(options: CreateFreeroundOptions): Promise<unknown> {
  const res = await postAgent("/v4/game/freeround/create", {
    user_code: options.userCode,
    provider_id: options.providerId,
    game_symbol: options.gameSymbol,
    bet: options.bet,
    win: options.win,
    rounds: options.rounds,
    expirationDate: options.expirationDate,
  });
  return res.data;
}

/**
 * Confirmado: POST /v4/game/freeround/cancel — pedido testado com `{ fr_id: "string" }`,
 * devolveu `FREEROUND_NO_EXIST` (código 2020) propagado por postAgent() — esperado, nenhum
 * freeround real foi criado ainda (freeround/create nunca passou da validação de
 * expirationDate). Forma de sucesso ainda não vista.
 */
export async function cancelFreeround(frId: string): Promise<unknown> {
  const res = await postAgent("/v4/game/freeround/cancel", { fr_id: frId });
  return res.data;
}

export interface ListTransactionsOptions {
  /** "YYYY-MM-DD HH:MM:SS", tal como confirmado no pedido real. */
  startTime: string;
  endTime: string;
  offset?: number;
  limit?: number;
}

export interface TransactionsPage {
  total: number;
  offset: number;
  count: number;
  list: unknown[];
}

/**
 * Confirmado: POST /v4/game/transaction — pedido testado com uma janela de tempo antiga
 * (2022-12-26), devolveu `{ total: 0, offset: 0, count: 0, list: [] }` — confirma o envelope de
 * paginação (total/offset/count/list), mas a forma de cada item de `list` ainda não foi vista
 * (esperado, `list` veio vazia — nenhuma transação real aconteceu ainda nesta integração).
 */
export async function listTransactions(options: ListTransactionsOptions): Promise<TransactionsPage> {
  const res = await postAgent<TransactionsPage>("/v4/game/transaction", {
    start_time: options.startTime,
    end_time: options.endTime,
    offset: options.offset ?? 0,
    limit: options.limit ?? 10,
  });
  return res.data;
}
