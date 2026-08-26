-- AlterTable
ALTER TABLE "Bet" ADD COLUMN     "boostPercent" INTEGER,
ADD COLUMN     "featuredComboId" TEXT;

-- CreateTable
CREATE TABLE "FeaturedCombo" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "sport" TEXT NOT NULL,
    "legs" JSONB NOT NULL,
    "boostPercent" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "FeaturedCombo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FeaturedCombo_eventId_active_idx" ON "FeaturedCombo"("eventId", "active");

-- AddForeignKey
ALTER TABLE "Bet" ADD CONSTRAINT "Bet_featuredComboId_fkey" FOREIGN KEY ("featuredComboId") REFERENCES "FeaturedCombo"("id") ON DELETE SET NULL ON UPDATE CASCADE;
