ALTER TABLE "CasinoAccount"
  ADD COLUMN "providerUserCode" INTEGER;
CREATE INDEX "CasinoAccount_providerUserCode_idx" ON "CasinoAccount"("providerUserCode");
