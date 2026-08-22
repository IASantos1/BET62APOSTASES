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
