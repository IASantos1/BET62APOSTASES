import { prisma } from "../../lib/prisma";
import { Errors } from "../../lib/errors";
import { createCasinoUser } from "./apiClient";

// Cria a conta do jogador no provedor (POST /v4/user/create) e guarda o mapeamento local
// (CasinoAccount) usado pelo callback (ver casino/callback.ts) para encontrar a carteira certa
// nos comandos "authenticate"/"balance"/"bet"/"win"/"cancel". `account` = user.publicId — um
// identificador já único e estável, sem expor o UUID interno.
//
// Ordem importa: confirmado ao vivo (ver docs/CASINO_SLOTS.md) que user/create dispara, de forma
// síncrona, um callback real "authenticate" para este `account` ANTES de o provedor terminar a
// criação da conta — é assim que ele valida que a conta existe do nosso lado. Por isso o
// CasinoAccount tem de existir ANTES de chamar createCasinoUser, não depois: criá-lo depois (como
// estava) fazia o nosso próprio handler de callback devolver ACCOUNT_NOT_FOUND a esse callback, e
// o provedor por sua vez devolvia CALLBACK_ERROR ao user/create — só descoberto porque o teste de
// conectividade (agent/callback-test, que não passa por handleAuthenticate) tinha funcionado.
// Se createCasinoUser falhar, desfaz-se o registo local para não ficar um mapeamento órfão.
//
// `providerResult` (a resposta crua de user/create, nunca vista com sucesso até agora — ver
// docs/CASINO_SLOTS.md) vem incluída na resposta só para diagnóstico: presume-se que traga o
// `user_code` que o lançamento de jogo (game-url) exige, mas isso ainda não foi confirmado, por
// isso não se guarda nada disto na base de dados enquanto a forma não for vista ao vivo.
// `justCreated` distingue "acabei de chamar o provedor agora" de "já existia" — usar isto (não a
// verdade/falsidade de `providerResult`) para decidir se há algo novo para mostrar, porque uma
// resposta de sucesso vazia (`null`) do provedor é um resultado válido, não deve ser tratada como
// "não aconteceu nada".
export async function provisionCasinoAccount(userId: string) {
  const existing = await prisma.casinoAccount.findUnique({ where: { userId } });
  if (existing) return { ...existing, providerResult: null, justCreated: false };

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw Errors.notFound("Utilizador não encontrado");

  const account = await prisma.casinoAccount.create({ data: { userId, account: user.publicId } });
  let providerResult: unknown;
  try {
    providerResult = await createCasinoUser(user.publicId);
  } catch (err) {
    await prisma.casinoAccount.delete({ where: { userId } });
    throw err;
  }
  return { ...account, providerResult, justCreated: true };
}
