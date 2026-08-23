import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { computeCashOutOffer } from "@/modules/betting/cashout";
import type { LiveEvent } from "@/modules/sports/types";

function makeBet(overrides: Partial<{ status: string; stake: string; totalOdd: string; potentialReturn: string }> = {}) {
  return {
    id: "bet1",
    userId: "u1",
    walletId: "w1",
    type: "SIMPLES",
    stake: new Prisma.Decimal(overrides.stake ?? "10.00"),
    totalOdd: new Prisma.Decimal(overrides.totalOdd ?? "2.000"),
    potentialReturn: new Prisma.Decimal(overrides.potentialReturn ?? "20.00"),
    status: overrides.status ?? "PENDING",
    payout: null,
    settledAt: null,
    createdAt: new Date(),
  } as any;
}

function makeSelection(overrides: Partial<{ status: string; eventId: string; market: string; selection: string; odd: string }> = {}) {
  return {
    id: "sel1",
    betId: "bet1",
    eventId: overrides.eventId ?? "pulsescore:1",
    sport: "football",
    league: "Liga",
    home: "Casa FC",
    away: "Fora FC",
    market: overrides.market ?? "Match Odds",
    selection: overrides.selection ?? "Home",
    odd: new Prisma.Decimal(overrides.odd ?? "2.000"),
    kickoffAt: null,
    status: overrides.status ?? "PENDING",
    finalHomeScore: null,
    finalAwayScore: null,
    settledAt: null,
    reviewNotes: null,
    reviewedByUserId: null,
    reviewedAt: null,
  } as any;
}

function liveEventWithOdd(id: string, market: string, selection: string, odd: number, isActive = true): LiveEvent {
  return {
    id,
    sport: "football",
    league: "Liga",
    home: "Casa FC",
    away: "Fora FC",
    status: "live",
    odds: [{ market, isActive: true, selections: { [selection]: { odd, isActive } } }],
  } as any;
}

describe("computeCashOutOffer", () => {
  it("odd atual mais curta (posição mais provável de ganhar) dá valor ACIMA do stake", () => {
    const bet = makeBet({ stake: "10.00", totalOdd: "2.000", potentialReturn: "20.00" });
    const sel = makeSelection({ odd: "2.000" });
    const live = [liveEventWithOdd("pulsescore:1", "Match Odds", "Home", 1.2)];
    const offer = computeCashOutOffer(bet, [sel], live);
    expect(offer.eligible).toBe(true);
    // fairValue = 10 * 2/1.2 = 16.667; com margem 0.92 = 15.33
    expect(offer.value).toBeCloseTo(15.33, 1);
    expect(offer.value!).toBeGreaterThan(10);
  });

  it("odd atual mais longa (posição menos provável) dá valor ABAIXO do stake", () => {
    const bet = makeBet({ stake: "10.00", totalOdd: "2.000", potentialReturn: "20.00" });
    const sel = makeSelection({ odd: "2.000" });
    const live = [liveEventWithOdd("pulsescore:1", "Match Odds", "Home", 5.0)];
    const offer = computeCashOutOffer(bet, [sel], live);
    expect(offer.eligible).toBe(true);
    // fairValue = 10 * 2/5 = 4; com margem 0.92 = 3.68
    expect(offer.value).toBeCloseTo(3.68, 1);
    expect(offer.value!).toBeLessThan(10);
  });

  it("nunca oferece mais do que o retorno potencial máximo", () => {
    const bet = makeBet({ stake: "10.00", totalOdd: "2.000", potentialReturn: "20.00" });
    const sel = makeSelection({ odd: "2.000" });
    const live = [liveEventWithOdd("pulsescore:1", "Match Odds", "Home", 0.01)]; // hipótese extrema
    const offer = computeCashOutOffer(bet, [sel], live);
    expect(offer.value!).toBeLessThanOrEqual(20);
  });

  it("aposta já liquidada não é elegível", () => {
    const bet = makeBet({ status: "WON" });
    const sel = makeSelection();
    const offer = computeCashOutOffer(bet, [sel], []);
    expect(offer.eligible).toBe(false);
  });

  it("seleção já decidida bloqueia o cash out da aposta inteira", () => {
    const bet = makeBet();
    const sel = makeSelection({ status: "WON" });
    const offer = computeCashOutOffer(bet, [sel], []);
    expect(offer.eligible).toBe(false);
  });

  it("evento não está ao vivo (ainda não começou / já terminou) bloqueia o cash out", () => {
    const bet = makeBet();
    const sel = makeSelection();
    const offer = computeCashOutOffer(bet, [sel], []); // sem eventos ao vivo
    expect(offer.eligible).toBe(false);
  });

  it("mercado suspenso no momento bloqueia o cash out", () => {
    const bet = makeBet();
    const sel = makeSelection();
    const live = [liveEventWithOdd("pulsescore:1", "Match Odds", "Home", 1.5, false)];
    const offer = computeCashOutOffer(bet, [sel], live);
    expect(offer.eligible).toBe(false);
  });

  it("Múltipla: uma perna sem odds ao vivo bloqueia o cash out da aposta inteira", () => {
    const bet = makeBet({ totalOdd: "4.000", potentialReturn: "40.00" });
    const sel1 = makeSelection({ eventId: "pulsescore:1", odd: "2.000" });
    const sel2 = makeSelection({ eventId: "pulsescore:2", odd: "2.000" });
    const live = [liveEventWithOdd("pulsescore:1", "Match Odds", "Home", 1.5)]; // só o primeiro jogo está ao vivo
    const offer = computeCashOutOffer(bet, [sel1, sel2], live);
    expect(offer.eligible).toBe(false);
  });
});
