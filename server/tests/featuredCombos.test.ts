import { describe, it, expect } from "vitest";
import { priceLegsAgainstEvent, applyBoost, buildAutoTemplates, looksLikePlayerName } from "@/modules/featuredCombos/service";
import type { LiveEvent } from "@/modules/sports/types";

function fakeEvent(odds: LiveEvent["odds"]): LiveEvent {
  return {
    id: "sportmonks:1",
    sport: "football",
    league: "Test League",
    home: "Real Madrid",
    away: "Real Sociedad",
    minuteOrPeriod: "",
    status: "scheduled",
    odds,
    updatedAt: new Date().toISOString(),
    source: "sportmonks",
  };
}

describe("priceLegsAgainstEvent", () => {
  const event = fakeEvent([
    { market: "Fulltime Result", isActive: true, selections: { "1": { odd: 1.9, isActive: true } } },
    { market: "Anytime Goalscorer", isActive: true, selections: { "Vinicius Junior": { odd: 1.85, isActive: true } } },
    { market: "Total Goals", isActive: true, selections: { "Over 3.5": { odd: 2.5, isActive: false } } },
  ]);

  it("resolve todas as pernas quando cada mercado/seleção existe e está ativa", () => {
    const priced = priceLegsAgainstEvent(event, [
      { market: "Fulltime Result", selection: "1" },
      { market: "Anytime Goalscorer", selection: "Vinicius Junior" },
    ]);
    expect(priced).toEqual([
      { market: "Fulltime Result", selection: "1", realOdd: 1.9 },
      { market: "Anytime Goalscorer", selection: "Vinicius Junior", realOdd: 1.85 },
    ]);
  });

  it("devolve null (nunca parcial) quando uma seleção está suspensa", () => {
    const priced = priceLegsAgainstEvent(event, [
      { market: "Fulltime Result", selection: "1" },
      { market: "Total Goals", selection: "Over 3.5" }, // isActive:false
    ]);
    expect(priced).toBeNull();
  });

  it("devolve null quando um mercado já não existe no evento", () => {
    const priced = priceLegsAgainstEvent(event, [{ market: "Corners", selection: "Over 8.5" }]);
    expect(priced).toBeNull();
  });
});

describe("applyBoost — distribuição geométrica do boost pelas pernas", () => {
  it("o produto das odds boostadas bate exatamente com realCombinedOdd × fator de boost", () => {
    const legs = [
      { market: "Fulltime Result", selection: "1", realOdd: 1.9 },
      { market: "Anytime Goalscorer", selection: "Vinicius Junior", realOdd: 1.85 },
      { market: "Total Goals", selection: "Over 3.5", realOdd: 2.5 },
    ];
    const result = applyBoost(legs, 20); // 20% boost, como no exemplo real do utilizador

    const realCombinedOdd = 1.9 * 1.85 * 2.5;
    expect(result.realCombinedOdd).toBeCloseTo(realCombinedOdd, 10);
    expect(result.boostedCombinedOdd).toBeCloseTo(realCombinedOdd * 1.2, 10);

    const boostedProduct = result.legs.reduce((acc, l) => acc * l.boostedOdd, 1);
    expect(boostedProduct).toBeCloseTo(result.boostedCombinedOdd, 8);
  });

  it("cada perna individual fica só ligeiramente acima da odd real (nunca toda a percentagem numa só)", () => {
    const legs = [
      { market: "A", selection: "x", realOdd: 2.0 },
      { market: "B", selection: "y", realOdd: 2.0 },
    ];
    const result = applyBoost(legs, 10); // +10% no total
    for (const leg of result.legs) {
      // raiz quadrada de 1.10 ≈ 1.0488 — bem menos do que 1.10 aplicado a uma só perna
      expect(leg.boostedOdd).toBeGreaterThan(2.0);
      expect(leg.boostedOdd).toBeLessThan(2.0 * 1.1);
    }
  });

  it("uma só perna: o boost fica todo nela (raiz de grau 1 = o próprio fator)", () => {
    const result = applyBoost([{ market: "A", selection: "x", realOdd: 3.0 }], 20);
    expect(result.legs[0]!.boostedOdd).toBeCloseTo(3.6, 10);
  });
});

describe("looksLikePlayerName — segunda barreira contra o bug real já visto (rótulos de papel em vez de nomes)", () => {
  it("rejeita as palavras de papel confirmadas numa amostra real (Anytime/First/Last/Score...)", () => {
    for (const label of ["Anytime", "First", "Last", "Score", "Score or Assist", "Yes", "No"]) {
      expect(looksLikePlayerName(label, "Real Madrid", "Real Sociedad")).toBe(false);
    }
  });
  it("rejeita os nomes das próprias equipas e valores numéricos", () => {
    expect(looksLikePlayerName("Real Madrid", "Real Madrid", "Real Sociedad")).toBe(false);
    expect(looksLikePlayerName("3.5", "Real Madrid", "Real Sociedad")).toBe(false);
  });
  it("aceita um nome de jogador plausível", () => {
    expect(looksLikePlayerName("Vinicius Junior", "Real Madrid", "Real Sociedad")).toBe(true);
  });
});

describe("buildAutoTemplates — geração automática das \"Melhores Escolhas\" a partir de odds reais", () => {
  it("monta Resultado + Golos (+ Marcador quando existir) quando essas pernas existem com odds válidas", () => {
    const event = fakeEvent([
      { market: "Fulltime Result", isActive: true, selections: { "1": { odd: 1.4, isActive: true }, X: { odd: 4.5, isActive: true }, "2": { odd: 7.0, isActive: true } } },
      { market: "Total Goals", isActive: true, selections: { "Over 2.5": { odd: 1.95, isActive: true }, "Under 2.5": { odd: 1.85, isActive: true } } },
      { market: "Anytime Goalscorer", isActive: true, selections: { "Vinicius Junior": { odd: 1.85, isActive: true }, "Kylian Mbappe": { odd: 2.1, isActive: true } } },
    ]);
    const templates = buildAutoTemplates(event);
    expect(templates.length).toBeGreaterThan(0);
    const withScorer = templates.find((t) => t.some((leg) => leg.market === "Anytime Goalscorer"));
    expect(withScorer).toBeDefined();
    expect(withScorer).toContainEqual({ market: "Fulltime Result", selection: "1" });
    expect(withScorer).toContainEqual({ market: "Total Goals", selection: "Over 2.5" });
    expect(withScorer).toContainEqual({ market: "Anytime Goalscorer", selection: "Vinicius Junior" }); // odd mais baixa = favorito
  });

  it("nunca escolhe o empate como perna de Resultado Final", () => {
    const event = fakeEvent([
      { market: "Fulltime Result", isActive: true, selections: { "1": { odd: 3.2, isActive: true }, X: { odd: 1.1, isActive: true }, "2": { odd: 3.5, isActive: true } } },
      { market: "Total Goals", isActive: true, selections: { "Over 2.5": { odd: 1.9, isActive: true } } },
    ]);
    const templates = buildAutoTemplates(event);
    for (const legs of templates) {
      for (const leg of legs) {
        if (leg.market === "Fulltime Result") expect(leg.selection).not.toBe("X");
      }
    }
  });

  it("não inventa uma combinação quando faltam mercados suficientes (só Resultado, sem Golos/BTTS/Cantos)", () => {
    const event = fakeEvent([{ market: "Fulltime Result", isActive: true, selections: { "1": { odd: 1.5, isActive: true } } }]);
    expect(buildAutoTemplates(event)).toEqual([]);
  });

  it("rejeita uma perna de Marcador cuja seleção é uma palavra de papel, não um nome de jogador", () => {
    const event = fakeEvent([
      { market: "Fulltime Result", isActive: true, selections: { "1": { odd: 1.5, isActive: true } } },
      { market: "Total Goals", isActive: true, selections: { "Over 2.5": { odd: 1.9, isActive: true } } },
      { market: "Anytime Goalscorer", isActive: true, selections: { Anytime: { odd: 1.2, isActive: true } } }, // rótulo de papel, não jogador
    ]);
    const templates = buildAutoTemplates(event);
    for (const legs of templates) {
      for (const leg of legs) {
        expect(leg.selection).not.toBe("Anytime");
      }
    }
  });
});
