import { env } from "../../config/env";
import { logger } from "../../lib/logger";
import { Errors } from "../../lib/errors";

/**
 * Cliente da "Agent API" do goldslotpalase.com (Cassino Gold Palace) — confirmado via Swagger
 * real: https://agent.goldslotpalase.com/swagger/v4/swagger.json (OpenAPI 3.0.4, "Agent API
 * Documentation" v4). Todos os endpoints são POST sob /v4/..., autenticados por
 * "Authorization: Bearer {CASINO_AGENT_KEY}".
 */

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

/** Info do agente — inclui `whitelist` e `client_ip`, úteis para diagnosticar bloqueios de IP. */
export async function getAgentInfo(): Promise<AgentInfo> {
  const res = await postAgent<AgentInfo>("/v4/agent/info");
  return res.data;
}

/**
 * Cria (ou obtém, se já existir) o utilizador no sistema do provedor a partir de um `name`
 * alfanumérico (a API só aceita `^[_a-zA-Z0-9]+$`, por isso nunca usamos o nosso UUID em bruto —
 * ver accountForUser()/userIdFromAccount() em service.ts). Idempotente: "se um utilizador for
 * criado com o mesmo nome, devolve a informação do utilizador existente" (doc do provedor).
 */
export async function createOrGetProviderUser(name: string): Promise<{ userCode: number; isNewUser: boolean }> {
  const res = await postAgent<{ user_code: number; is_new_user: boolean }>("/v4/user/create", { name });
  return { userCode: res.data.user_code, isNewUser: res.data.is_new_user };
}

/** Código de idioma "Portuguese" confirmado na tabela multilíngue do Swagger (1=EN...6=PT). */
export const LANG_PORTUGUESE = 6;

/**
 * Pede o URL de lançamento de um jogo — válido por 10 minutos, uso único (não pode ser
 * reutilizado). `rtp: 0` usa o RTP por omissão do agente.
 */
export async function getGameLaunchUrl(params: {
  userCode: number;
  providerId: number;
  gameSymbol: string;
  lang?: number;
  returnUrl?: string;
  rtp?: number;
}): Promise<string> {
  const res = await postAgent<{ game_url: string }>("/v4/game/game-url", {
    user_code: params.userCode,
    provider_id: params.providerId,
    game_symbol: params.gameSymbol,
    lang: params.lang ?? LANG_PORTUGUESE,
    return_url: params.returnUrl ?? "",
    rtp: params.rtp ?? 0,
  });
  return res.data.game_url;
}

export interface ProviderInfo {
  provider_id: number;
  provider_name: string;
  locale_name: string;
  status: number;
}

/** Lista de provedores de jogo atribuídos ao agente (ex: Pragmatic Play = provider_id 1). */
export async function listProviders(lang = LANG_PORTUGUESE): Promise<ProviderInfo[]> {
  const res = await postAgent<ProviderInfo[]>("/v4/game/providers", { lang });
  return res.data ?? [];
}

export interface ProviderGame {
  provider_id: number;
  game_code: string;
  game_name: string;
  locale_name: string;
  game_image: string;
  game_image_narrow?: string;
  launch_enable: boolean;
  category: string;
  reg_date: string;
}

/** Lista de jogos ao vivo de um provedor — mesma forma do catálogo estático já guardado. */
export async function listProviderGames(providerId: number, lang = LANG_PORTUGUESE): Promise<ProviderGame[]> {
  const res = await postAgent<ProviderGame[]>("/v4/game/games", { provider_id: providerId, lang });
  return res.data ?? [];
}
