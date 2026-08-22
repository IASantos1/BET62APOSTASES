-- Tabelas para o contrato de callback confirmado do Cassino Gold Palace (autenticação, saldo,
-- débito/crédito de apostas, cancelamento) — ver docs/CASINO_SLOTS.md e casino/callback.ts.

-- CreateTable
CREATE TABLE "CasinoAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CasinoAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CasinoCallbackTransaction" (
    "id" TEXT NOT NULL,
    "transGuid" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "gplayId" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "providerId" INTEGER NOT NULL,
    "gameCode" TEXT NOT NULL,
    "gameType" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "type" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CasinoCallbackTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CasinoAccount_userId_key" ON "CasinoAccount"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "CasinoAccount_account_key" ON "CasinoAccount"("account");

-- CreateIndex
CREATE UNIQUE INDEX "CasinoCallbackTransaction_transGuid_key" ON "CasinoCallbackTransaction"("transGuid");

-- CreateIndex
CREATE INDEX "CasinoCallbackTransaction_account_createdAt_idx" ON "CasinoCallbackTransaction"("account", "createdAt");

-- AddForeignKey
ALTER TABLE "CasinoAccount" ADD CONSTRAINT "CasinoAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
