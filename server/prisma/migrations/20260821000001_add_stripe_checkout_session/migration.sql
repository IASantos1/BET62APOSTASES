-- AlterTable
ALTER TABLE "Deposit" ADD COLUMN "stripeSessionId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Deposit_stripeSessionId_key" ON "Deposit"("stripeSessionId");

-- CreateIndex
CREATE INDEX "Deposit_stripeSessionId_idx" ON "Deposit"("stripeSessionId");
