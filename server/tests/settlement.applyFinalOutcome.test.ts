import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: vi.fn(),
  },
}));

import { calculateBetResult } from "@/modules/betting/settlement";

describe("calculateBetResult — SIMPLES", () => {
  it("aposta individual GANHA: payout = stake * odd", () => {
    const result = calculateBetResult({
      stake: "10.00",
      selections: [{ status: "WON", odd: "2.10" }],
    });
    expect(result.status).toBe("WON");
    expect(result.stake.toNumber()).toBeCloseTo(10);
    expect(result.payout.toNumber()).toBeCloseTo(21);
    expect(result.netResult.toNumber()).toBeCloseTo(11);
  });

  it("aposta individual PERDIDA: payout 0, netResult = -stake", () => {
    const result = calculateBetResult({
      stake: "10.00",
      selections: [{ status: "LOST", odd: "2.10" }],
    });
    expect(result.status).toBe("LOST");
    expect(result.payout.toNumber()).toBe(0);
    expect(result.netResult.toNumber()).toBeCloseTo(-10);
  });

  it("aposta individual VOID: devolução total (payout = stake, net = 0)", () => {
    const result = calculateBetResult({
      stake: "10.00",
      selections: [{ status: "VOID", odd: "2.10" }],
    });
    expect(result.status).toBe("VOID");
    expect(result.payout.toNumber()).toBeCloseTo(10);
    expect(result.netResult.toNumber()).toBeCloseTo(0);
  });
});

describe("calculateBetResult — MÚLTIPLA com 2 seleções", () => {
  it("ambas WON: odd efetiva = produto; payout = stake * odd1 * odd2", () => {
    const result = calculateBetResult({
      stake: "10.00",
      selections: [
        { status: "WON", odd: "2.00" },
        { status: "WON", odd: "3.00" },
      ],
    });
    expect(result.status).toBe("WON");
    expect(result.payout.toNumber()).toBeCloseTo(60);
    expect(result.netResult.toNumber()).toBeCloseTo(50);
  });

  it("uma LOST => múltipla LOST (payout 0)", () => {
    const result = calculateBetResult({
      stake: "10.00",
      selections: [
        { status: "WON", odd: "2.00" },
        { status: "LOST", odd: "3.00" },
      ],
    });
    expect(result.status).toBe("LOST");
    expect(result.payout.toNumber()).toBe(0);
  });

  it("uma WON outra VOID: odd efetiva = só da WON (VOID = fator 1.0)", () => {
    const result = calculateBetResult({
      stake: "10.00",
      selections: [
        { status: "WON", odd: "2.50" },
        { status: "VOID", odd: "3.00" },
      ],
    });
    expect(result.status).toBe("WON");
    expect(result.payout.toNumber()).toBeCloseTo(25);
    expect(result.netResult.toNumber()).toBeCloseTo(15);
  });

  it("ambas VOID => VOID total (devolve stake)", () => {
    const result = calculateBetResult({
      stake: "10.00",
      selections: [
        { status: "VOID", odd: "2.50" },
        { status: "VOID", odd: "3.00" },
      ],
    });
    expect(result.status).toBe("VOID");
    expect(result.payout.toNumber()).toBeCloseTo(10);
    expect(result.netResult.toNumber()).toBeCloseTo(0);
  });
});

describe("calculateBetResult — BET_BUILDER (3 seleções mesmo evento)", () => {
  it("todas WON => odd produto; alguma LOST => total LOST", () => {
    const result = calculateBetResult({
      stake: "20.00",
      selections: [
        { status: "WON", odd: "1.60" },
        { status: "WON", odd: "1.90" },
        { status: "WON", odd: "2.20" },
      ],
    });
    // 1.6 * 1.9 = 3.04; * 2.2 = 6.688; * 20 = 133.76
    expect(result.payout.toNumber()).toBeCloseTo(133.76, 2);
    expect(result.status).toBe("WON");

    const result2 = calculateBetResult({
      stake: "20.00",
      selections: [
        { status: "WON", odd: "1.60" },
        { status: "LOST", odd: "1.90" },
        { status: "WON", odd: "2.20" },
      ],
    });
    expect(result2.status).toBe("LOST");
    expect(result2.payout.toNumber()).toBe(0);
  });
});

describe("calculateBetResult — PUSH (Settlement Engine, Over/Under linha inteira)", () => {
  it("aposta individual PUSH: devolução total, igual a VOID financeiramente", () => {
    const result = calculateBetResult({
      stake: "10.00",
      selections: [{ status: "PUSH", odd: "1.90" }],
    });
    expect(result.status).toBe("VOID");
    expect(result.payout.toNumber()).toBeCloseTo(10);
    expect(result.netResult.toNumber()).toBeCloseTo(0);
  });

  it("múltipla com uma WON e uma PUSH: PUSH não altera a odd efetiva", () => {
    const result = calculateBetResult({
      stake: "10.00",
      selections: [
        { status: "WON", odd: "2.00" },
        { status: "PUSH", odd: "1.80" },
      ],
    });
    expect(result.status).toBe("WON");
    expect(result.payout.toNumber()).toBeCloseTo(20);
  });

  it("múltipla com uma LOST e uma PUSH: continua LOST (PUSH não salva a aposta)", () => {
    const result = calculateBetResult({
      stake: "10.00",
      selections: [
        { status: "LOST", odd: "2.00" },
        { status: "PUSH", odd: "1.80" },
      ],
    });
    expect(result.status).toBe("LOST");
    expect(result.payout.toNumber()).toBe(0);
  });
});

describe("calculateBetResult — HALF_WIN / HALF_LOSS (Handicap Asiático fracionado)", () => {
  it("HALF_WIN: paga metade à odd, metade devolvida (fator (1+odd)/2)", () => {
    const result = calculateBetResult({
      stake: "10.00",
      selections: [{ status: "HALF_WIN", odd: "2.00" }],
    });
    // fator = (1+2)/2 = 1.5 → payout = 15 (5 devolvidos + 5 de lucro, metade do lucro pleno de 10)
    expect(result.payout.toNumber()).toBeCloseTo(15);
    expect(result.status).toBe("WON");
  });

  it("HALF_LOSS: perde metade do stake, devolve a outra metade (fator 0.5)", () => {
    const result = calculateBetResult({
      stake: "10.00",
      selections: [{ status: "HALF_LOSS", odd: "2.00" }],
    });
    expect(result.payout.toNumber()).toBeCloseTo(5);
    expect(result.netResult.toNumber()).toBeCloseTo(-5);
  });
});

describe("calculateBetResult — odd corrigida se divergir do original", () => {
  it("usa odd passada no parametro (do feed final) independentemente da odd no bet", () => {
    const result = calculateBetResult({
      stake: "10.00",
      selections: [{ status: "WON", odd: "1.95" }],
    });
    expect(result.payout.toNumber()).toBeCloseTo(19.5);
    expect(result.netResult.toNumber()).toBeCloseTo(9.5);
  });
});
