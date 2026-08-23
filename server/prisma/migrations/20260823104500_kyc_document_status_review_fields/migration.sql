-- CreateEnum
CREATE TYPE "KycDocStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable (KycDocument: sha256 integridade + estado revisão)
ALTER TABLE "KycDocument" ADD COLUMN     "sha256" TEXT;
ALTER TABLE "KycDocument" ADD COLUMN     "status" "KycDocStatus" NOT NULL DEFAULT 'PENDING';
ALTER TABLE "KycDocument" ADD COLUMN     "reviewNotes" TEXT;
ALTER TABLE "KycDocument" ADD COLUMN     "reviewedByUserId" TEXT;
ALTER TABLE "KycDocument" ADD COLUMN     "reviewedAt" TIMESTAMP(3);

-- CreateIndex (para queries filtro por estado KYC: "pendentes de revisão", etc.)
CREATE INDEX "KycDocument_status_idx" ON "KycDocument"("status");
