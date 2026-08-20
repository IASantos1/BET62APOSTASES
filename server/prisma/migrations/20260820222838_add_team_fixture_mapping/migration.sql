-- CreateEnum
CREATE TYPE "MappingMethod" AS ENUM ('ID_KNOWN', 'ALIAS', 'NORMALIZED', 'SIMILARITY', 'MANUAL');

-- CreateTable
CREATE TABLE "TeamMapping" (
    "id" TEXT NOT NULL,
    "sport" TEXT NOT NULL,
    "apiFootballTeamId" INTEGER,
    "apiFootballName" TEXT,
    "normalizedApiName" TEXT,
    "pulsescoreName" TEXT NOT NULL,
    "normalizedPulsescoreName" TEXT NOT NULL,
    "country" TEXT,
    "confidence" INTEGER NOT NULL,
    "mappingMethod" "MappingMethod" NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeagueMapping" (
    "id" TEXT NOT NULL,
    "sport" TEXT NOT NULL,
    "apiFootballLeagueId" INTEGER,
    "apiFootballName" TEXT,
    "season" INTEGER,
    "pulsescoreName" TEXT NOT NULL,
    "normalizedPulsescoreName" TEXT NOT NULL,
    "country" TEXT,
    "confidence" INTEGER NOT NULL,
    "mappingMethod" "MappingMethod" NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeagueMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FixtureMapping" (
    "id" TEXT NOT NULL,
    "pulsescoreEventKey" TEXT NOT NULL,
    "apiFootballFixtureId" INTEGER,
    "homeTeamMappingId" TEXT,
    "awayTeamMappingId" TEXT,
    "leagueMappingId" TEXT,
    "kickoffPulsescore" TIMESTAMP(3),
    "kickoffApiFootball" TIMESTAMP(3),
    "confidence" INTEGER NOT NULL,
    "mappingMethod" "MappingMethod" NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FixtureMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamAlias" (
    "id" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "normalizedAlias" TEXT NOT NULL,
    "canonicalName" TEXT NOT NULL,
    "sport" TEXT NOT NULL DEFAULT 'football',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamAlias_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TeamMapping_sport_normalizedApiName_idx" ON "TeamMapping"("sport", "normalizedApiName");

-- CreateIndex
CREATE INDEX "TeamMapping_apiFootballTeamId_idx" ON "TeamMapping"("apiFootballTeamId");

-- CreateIndex
CREATE UNIQUE INDEX "TeamMapping_sport_normalizedPulsescoreName_key" ON "TeamMapping"("sport", "normalizedPulsescoreName");

-- CreateIndex
CREATE UNIQUE INDEX "LeagueMapping_sport_normalizedPulsescoreName_key" ON "LeagueMapping"("sport", "normalizedPulsescoreName");

-- CreateIndex
CREATE UNIQUE INDEX "FixtureMapping_pulsescoreEventKey_key" ON "FixtureMapping"("pulsescoreEventKey");

-- CreateIndex
CREATE INDEX "FixtureMapping_apiFootballFixtureId_idx" ON "FixtureMapping"("apiFootballFixtureId");

-- CreateIndex
CREATE INDEX "FixtureMapping_confidence_idx" ON "FixtureMapping"("confidence");

-- CreateIndex
CREATE UNIQUE INDEX "TeamAlias_sport_normalizedAlias_key" ON "TeamAlias"("sport", "normalizedAlias");

-- AddForeignKey
ALTER TABLE "FixtureMapping" ADD CONSTRAINT "FixtureMapping_homeTeamMappingId_fkey" FOREIGN KEY ("homeTeamMappingId") REFERENCES "TeamMapping"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FixtureMapping" ADD CONSTRAINT "FixtureMapping_awayTeamMappingId_fkey" FOREIGN KEY ("awayTeamMappingId") REFERENCES "TeamMapping"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FixtureMapping" ADD CONSTRAINT "FixtureMapping_leagueMappingId_fkey" FOREIGN KEY ("leagueMappingId") REFERENCES "LeagueMapping"("id") ON DELETE SET NULL ON UPDATE CASCADE;
