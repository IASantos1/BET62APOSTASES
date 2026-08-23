import { prisma } from "../../lib/prisma";
import { Errors } from "../../lib/errors";
import { createCasinoUser } from "./apiClient";
import { logger } from "../../lib/logger";

// Tenta extrair o `user_code` numérico de uma resposta de sucesso de POST /v4/user/create.
// A forma exata de sucesso ainda NÃO foi vista ao vivo (ver docs/CASINO_SLOTS.md), por isso
// cobre-se todos os shapes plausíveis com base nos padrões já confirmados noutros endpoints
// do provedor (snake_case camelCase / aninhado em `data` / no topo / string que parseia para
// int). Devolve null se nenhum padrão bater (chamada de cima pode tentar de novo mais tarde).
export function extractUserCodeFromCreateUser(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const candidates: unknown[] = [];
  if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    candidates.push(obj.user_code, obj.userCode, obj.code, obj.userId, obj.id, obj.data);
    if (typeof obj.data === "object" && obj.data !== null) {
      const d = obj.data as Record<string, unknown>;
      candidates.push(d.user_code, d.userCode, d.code, d.userId, d.id);
    }
  }
  for (const c of candidates) {
    if (typeof c === "number" && Number.isInteger(c) && c > 0) return c;
    if (typeof c === "string" && c.trim() !== "") {
      const n = Number(c);
      if (Number.isInteger(n) && n > 0) return n;
    }
  }
  return null;
}

export async function provisionCasinoAccount(userId: string) {
  const existing = await prisma.casinoAccount.findUnique({ where: { userId } });

  // Já existe e já tem providerUserCode — caminho feliz instantâneo.
  if (existing && existing.providerUserCode !== null) {
    return { ...existing, providerResult: null, justCreated: false, userCodeExtracted: true };
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw Errors.notFound("Utilizador não encontrado");

  // Se já existe mas providerUserCode ficou null (resposta de createCasinoUser não
  // parseou da primeira vez — ver docs/CASINO_SLOTS.md), re-tentar uma extração
  // do mesmo user (campo account = user.publicId já gravado) SEM apagar e recriar
  // a conta — `createCasinoUser` é provavelmente idempotent e se for chamado com
  // o mesmo `name` de novo devolve o user_code existente.
  if (existing) {
    let providerResult: unknown;
    try {
      providerResult = await createCasinoUser(user.publicId);
    } catch (err) {
      logger.warn({ err: String(err).slice(0, 200), userId }, "[CASINO] provision: re-chamada createCasinoUser falhou, mantem conta existente");
      return { ...existing, providerResult: null, justCreated: false, userCodeExtracted: false };
    }
    const userCode = extractUserCodeFromCreateUser(providerResult);
    if (userCode !== null) {
      const updated = await prisma.casinoAccount.update({
        where: { userId },
        data: { providerUserCode: userCode },
      });
      return { ...updated, providerResult, justCreated: false, userCodeExtracted: true };
    }
    logger.warn(
      { providerResult: JSON.stringify(providerResult).slice(0, 300), userId },
      "[CASINO] provision: createCasinoUser sucesso mas user_code não parseado (próxima atualização do parser corrige)"
    );
    return { ...existing, providerResult, justCreated: false, userCodeExtracted: false };
  }

  // Primeira vez: criar mapeamento local ANTES de chamar o provedor (ver docs/CASINO_SLOTS.md
  // explicação completa — user/create dispara callback authenticate SÍNCRONO que precisa de
  // encontrar CasinoAccount já existente com account == user.publicId, senão o próprio
  // provedor devolve CALLBACK_ERROR e não cria nada).
  const account = await prisma.casinoAccount.create({ data: { userId, account: user.publicId } });
  let providerResult: unknown;
  try {
    providerResult = await createCasinoUser(user.publicId);
  } catch (err) {
    // Erro do provedor: não deixar registo órfão — se for um CALLBACK_ERROR ou similar,
    // mantemos a conta local (já que o próximo pedido vai precisar dela do mesmo jeito,
    // a falha não é nossa, é do lado do provedor a chegar ao callback). Só apagamos se for
    // um erro nosso (ex: Utilizador não encontrado), o que não deve acontecer aqui.
    logger.warn(
      { err: String(err).slice(0, 300), userId, account: user.publicId },
      "[CASINO] provision: createCasinoUser falhou — mantem CasinoAccount local (callback authenticate precisa existir do próximo pedido)"
    );
    return { ...account, providerResult: null, justCreated: true, userCodeExtracted: false };
  }

  const userCode = extractUserCodeFromCreateUser(providerResult);
  if (userCode !== null) {
    const updated = await prisma.casinoAccount.update({
      where: { userId },
      data: { providerUserCode: userCode },
    });
    return { ...updated, providerResult, justCreated: true, userCodeExtracted: true };
  }

  logger.warn(
    { providerResult: JSON.stringify(providerResult).slice(0, 300), userId },
    "[CASINO] provision: createCasinoUser sucesso mas user_code não reconhecido — mantem null para o parser atualizar noutro deploy"
  );
  return { ...account, providerResult, justCreated: true, userCodeExtracted: false };
}
