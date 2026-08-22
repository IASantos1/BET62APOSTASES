-- Espelho local do catálogo completo do Cassino Gold Palace (POST /v4/game/all), preenchido por
-- um sync manual em vez de pedir o catálogo inteiro ao provedor em cada carregamento de página.

-- CreateTable
CREATE TABLE "CasinoGame" (
    "id" TEXT NOT NULL,
    "providerId" INTEGER NOT NULL,
    "gameCode" TEXT NOT NULL,
    "gameName" TEXT NOT NULL,
    "localeName" TEXT NOT NULL,
    "gameImage" TEXT NOT NULL,
    "gameImageNarrow" TEXT NOT NULL,
    "launchEnable" BOOLEAN NOT NULL DEFAULT true,
    "category" TEXT NOT NULL,
    "regDate" TEXT NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CasinoGame_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CasinoGame_category_idx" ON "CasinoGame"("category");

-- CreateIndex
CREATE INDEX "CasinoGame_launchEnable_idx" ON "CasinoGame"("launchEnable");

-- CreateIndex
CREATE UNIQUE INDEX "CasinoGame_providerId_gameCode_key" ON "CasinoGame"("providerId", "gameCode");
