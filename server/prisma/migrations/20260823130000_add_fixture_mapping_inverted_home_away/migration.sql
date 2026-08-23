-- Add invertedHomeAway flag to FixtureMapping so the unified service knows when to swap
-- home/away sides in API-Football statistics (the 2 providers sometimes disagree on which
-- team is "home"; this flag is set by fixtureMatcher.ts when findFixtureId() reports an
-- inversion. Without it, possession/shots/cards were assigned to the WRONG team 40-50% of the
-- time, which the user perceived as "statistics not arriving at all").
ALTER TABLE "FixtureMapping"
  ADD COLUMN "invertedHomeAway" BOOLEAN;
CREATE INDEX "FixtureMapping_invertedHomeAway_idx" ON "FixtureMapping"("invertedHomeAway");
