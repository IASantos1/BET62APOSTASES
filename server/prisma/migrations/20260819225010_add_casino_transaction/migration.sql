-- CreateEnum
CREATE TYPE "CasinoTxType" AS ENUM ('BET', 'WIN', 'CANCEL', 'BONUS_CALL_WIN');

-- CreateTable
CREATE TABLE "CasinoTransaction" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "transGuid" TEXT NOT NULL,
    "cancelOfTransGuid" TEXT,
    "type" "CasinoTxType" NOT NULL,
    "gplayId" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "providerId" INTEGER NOT NULL,
    "gameCode" TEXT NOT NULL,
    "gameType" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "callId" TEXT,
    "ledgerEntryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CasinoTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CasinoTransaction_transGuid_key" ON "CasinoTransaction"("transGuid");

-- CreateIndex
CREATE INDEX "CasinoTransaction_walletId_createdAt_idx" ON "CasinoTransaction"("walletId", "createdAt");

-- CreateIndex
CREATE INDEX "CasinoTransaction_roundId_idx" ON "CasinoTransaction"("roundId");

-- AddForeignKey
ALTER TABLE "CasinoTransaction" ADD CONSTRAINT "CasinoTransaction_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
