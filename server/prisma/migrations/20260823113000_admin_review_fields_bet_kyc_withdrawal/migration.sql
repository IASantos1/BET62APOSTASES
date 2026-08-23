-- FASE 2 F2-5: Admin review fields para auditoria SRIJ.
-- Campos opcionais (têm ? no Prisma); não quebram dados existentes.

ALTER TABLE "KycSubmission" ADD COLUMN "reviewNotes" TEXT;

ALTER TABLE "Withdrawal" ADD COLUMN "reviewNotes" TEXT;

ALTER TABLE "BetSelection" ADD COLUMN "reviewNotes" TEXT;
ALTER TABLE "BetSelection" ADD COLUMN "reviewedByUserId" TEXT;
ALTER TABLE "BetSelection" ADD COLUMN "reviewedAt" TIMESTAMP(3);
