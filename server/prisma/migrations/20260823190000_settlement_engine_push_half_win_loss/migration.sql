-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "BetSelectionStatus" ADD VALUE 'PUSH';
ALTER TYPE "BetSelectionStatus" ADD VALUE 'HALF_WIN';
ALTER TYPE "BetSelectionStatus" ADD VALUE 'HALF_LOSS';

-- AlterTable
ALTER TABLE "BetSelection" ADD COLUMN     "settlementReason" TEXT;

