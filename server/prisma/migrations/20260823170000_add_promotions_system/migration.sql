-- CreateEnum
CREATE TYPE "PromotionType" AS ENUM ('WELCOME_BONUS', 'DEPOSIT_BONUS', 'CASHBACK', 'FREEBET');

-- CreateEnum
CREATE TYPE "UserPromotionStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'EXPIRED', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "LedgerEntryType" ADD VALUE 'BONUS_GRANTED';
ALTER TYPE "LedgerEntryType" ADD VALUE 'BONUS_STAKE';
ALTER TYPE "LedgerEntryType" ADD VALUE 'BONUS_WON';
ALTER TYPE "LedgerEntryType" ADD VALUE 'BONUS_CONVERTED';
ALTER TYPE "LedgerEntryType" ADD VALUE 'BONUS_EXPIRED';

-- AlterTable
ALTER TABLE "Wallet" ADD COLUMN     "bonusBalance" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Bet" ADD COLUMN     "bonusStakeAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "userPromotionId" TEXT;

-- CreateTable
CREATE TABLE "Promotion" (
    "id" TEXT NOT NULL,
    "type" "PromotionType" NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "bonusPercent" DECIMAL(6,2),
    "bonusFixedAmount" DECIMAL(14,2),
    "bonusMaxAmount" DECIMAL(14,2),
    "minDepositAmount" DECIMAL(14,2),
    "rolloverMultiplier" DECIMAL(6,2) NOT NULL DEFAULT 5,
    "minOdd" DECIMAL(6,2) NOT NULL DEFAULT 1.50,
    "validityDays" INTEGER NOT NULL DEFAULT 7,
    "eligibleSports" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Promotion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserPromotion" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "promotionId" TEXT NOT NULL,
    "bonusAmount" DECIMAL(14,2) NOT NULL,
    "rolloverRequired" DECIMAL(14,2) NOT NULL,
    "rolloverProgress" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "minOdd" DECIMAL(6,2) NOT NULL,
    "status" "UserPromotionStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserPromotion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserPromotion_userId_status_idx" ON "UserPromotion"("userId", "status");

-- CreateIndex
CREATE INDEX "UserPromotion_status_expiresAt_idx" ON "UserPromotion"("status", "expiresAt");

-- AddForeignKey
ALTER TABLE "Bet" ADD CONSTRAINT "Bet_userPromotionId_fkey" FOREIGN KEY ("userPromotionId") REFERENCES "UserPromotion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPromotion" ADD CONSTRAINT "UserPromotion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPromotion" ADD CONSTRAINT "UserPromotion_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPromotion" ADD CONSTRAINT "UserPromotion_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "Promotion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

