import { prisma } from "../../lib/prisma";
import { Errors } from "../../lib/errors";
import { createCasinoUser } from "./apiClient";

// Cria a conta do jogador no provedor (POST /v4/user/create) e guarda o mapeamento local
// (CasinoAccount) usado pelo callback (ver casino/callback.ts) para encontrar a carteira certa
// nos comandos "authenticate"/"balance"/"bet"/"win"/"cancel". `account` = user.publicId — um
// identificador já único e estável, sem expor o UUID interno.
export async function provisionCasinoAccount(userId: string) {
  const existing = await prisma.casinoAccount.findUnique({ where: { userId } });
  if (existing) return existing;

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw Errors.notFound("Utilizador não encontrado");

  await createCasinoUser(user.publicId);

  return prisma.casinoAccount.create({ data: { userId, account: user.publicId } });
}
