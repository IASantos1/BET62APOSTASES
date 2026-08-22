-- Remove a integração do Cassino (Palace Casino / goldslotpalase.com) por completo, a pedido
-- explícito do utilizador — não foi possível fazer funcionar o lançamento real de jogos
-- (CALLBACK_ERROR persistente, investigado a fundo, aponta para um problema de rede do lado do
-- provedor que não se conseguiu contornar). Nenhuma transação real de jogo chegou a ser
-- processada em produção (o lançamento nunca funcionou), por isso não há histórico financeiro
-- real a perder aqui.

-- DropForeignKey
ALTER TABLE "CasinoTransaction" DROP CONSTRAINT IF EXISTS "CasinoTransaction_walletId_fkey";

-- DropTable
DROP TABLE IF EXISTS "CasinoTransaction";

-- DropTable
DROP TABLE IF EXISTS "CasinoGameOverride";

-- DropEnum
DROP TYPE IF EXISTS "CasinoTxType";
