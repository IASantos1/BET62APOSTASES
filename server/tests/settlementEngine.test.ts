import { describe, it, expect } from "vitest";
import { getSettlementAdapter, evaluateSelection, type MatchState } from "@/modules/settlement";

const footballAdapter = getSettlementAdapter("football");

function state(overrides: Partial<MatchState>): MatchState {
  return { finished: false, home: "Casa", away: "Fora", homeScore: null, awayScore: null, ...overrides };
}

describe("Settlement Engine — BTTS (liquidação antecipada assimétrica)", () => {
  it("0-0 ao vivo: Sim e Não continuam OPEN (nenhum é seguro decidir)", () => {
    const s = state({ homeScore: 0, awayScore: 0 });
    expect(evaluateSelection(footballAdapter, "Both Teams To Score", "Yes", s).verdict).toBe("OPEN");
    expect(evaluateSelection(footballAdapter, "Both Teams To Score", "No", s).verdict).toBe("OPEN");
  });

  it("1-0 ao vivo: ainda OPEN para os dois lados (só uma equipa marcou)", () => {
    const s = state({ homeScore: 1, awayScore: 0 });
    expect(evaluateSelection(footballAdapter, "Both Teams To Score", "Yes", s).verdict).toBe("OPEN");
    expect(evaluateSelection(footballAdapter, "Both Teams To Score", "No", s).verdict).toBe("OPEN");
  });

  it("1-1 ao vivo: Sim liquida WON antecipadamente, Não liquida LOST antecipadamente (irreversível)", () => {
    const s = state({ homeScore: 1, awayScore: 1 });
    const yes = evaluateSelection(footballAdapter, "Both Teams To Score", "Yes", s);
    const no = evaluateSelection(footballAdapter, "Both Teams To Score", "No", s);
    expect(yes.verdict).toBe("WON");
    expect(yes.reason).toBe("UNAMBIGUOUS_OUTCOME");
    expect(no.verdict).toBe("LOST");
    expect(no.reason).toBe("UNAMBIGUOUS_OUTCOME");
  });

  it("0-0 no final do jogo: Sim perde, Não ganha", () => {
    const s = state({ homeScore: 0, awayScore: 0, finished: true });
    expect(evaluateSelection(footballAdapter, "Both Teams To Score", "Yes", s)).toMatchObject({ verdict: "LOST", reason: "EVENT_FINISHED" });
    expect(evaluateSelection(footballAdapter, "Both Teams To Score", "No", s)).toMatchObject({ verdict: "WON", reason: "EVENT_FINISHED" });
  });
});

describe("Settlement Engine — Over/Under (liquidação antecipada)", () => {
  it("Over 2.5 com total=2 ao vivo: continua OPEN", () => {
    const s = state({ homeScore: 1, awayScore: 1 });
    expect(evaluateSelection(footballAdapter, "Total Goals", "Over 2.5", s).verdict).toBe("OPEN");
  });

  it("Over 2.5 com total=3 ao vivo: WON antecipado; Under 2.5 no mesmo momento: LOST antecipado", () => {
    const s = state({ homeScore: 2, awayScore: 1 });
    const over = evaluateSelection(footballAdapter, "Total Goals", "Over 2.5", s);
    const under = evaluateSelection(footballAdapter, "Total Goals", "Under 2.5", s);
    expect(over).toMatchObject({ verdict: "WON", reason: "UNAMBIGUOUS_OUTCOME" });
    expect(under).toMatchObject({ verdict: "LOST", reason: "UNAMBIGUOUS_OUTCOME" });
  });

  it("Over/Under 2.0 (linha inteira) com total final = 2: PUSH para os dois lados", () => {
    const s = state({ homeScore: 1, awayScore: 1, finished: true });
    expect(evaluateSelection(footballAdapter, "Total Goals", "Over 2.0", s)).toMatchObject({ verdict: "PUSH", reason: "EVENT_FINISHED" });
    expect(evaluateSelection(footballAdapter, "Total Goals", "Under 2.0", s)).toMatchObject({ verdict: "PUSH", reason: "EVENT_FINISHED" });
  });

  it("Under 2.5 só liquida WON no final (nunca antecipado enquanto total <= linha)", () => {
    const live = state({ homeScore: 1, awayScore: 0 });
    expect(evaluateSelection(footballAdapter, "Total Goals", "Under 2.5", live).verdict).toBe("OPEN");
    const final = state({ homeScore: 1, awayScore: 0, finished: true });
    expect(evaluateSelection(footballAdapter, "Total Goals", "Under 2.5", final)).toMatchObject({ verdict: "WON", reason: "EVENT_FINISHED" });
  });
});

describe("Settlement Engine — mercados que nunca liquidam antecipadamente", () => {
  it("1X2 nunca liquida com o jogo ainda a decorrer, mesmo com 3 golos de diferença", () => {
    const s = state({ homeScore: 3, awayScore: 0 });
    expect(evaluateSelection(footballAdapter, "Match Odds", "1", s).verdict).toBe("OPEN");
  });

  it("1X2 liquida no final", () => {
    const s = state({ homeScore: 3, awayScore: 0, finished: true });
    expect(evaluateSelection(footballAdapter, "Match Odds", "1", s)).toMatchObject({ verdict: "WON", reason: "EVENT_FINISHED" });
  });

  it("Resultado Exato nunca liquida antecipadamente mesmo já estando certo", () => {
    const s = state({ homeScore: 2, awayScore: 1 });
    expect(evaluateSelection(footballAdapter, "Correct Score", "2-1", s).verdict).toBe("OPEN");
    const final = state({ homeScore: 2, awayScore: 1, finished: true });
    expect(evaluateSelection(footballAdapter, "Correct Score", "2-1", final)).toMatchObject({ verdict: "WON", reason: "EVENT_FINISHED" });
  });
});

describe("Settlement Engine — Draw No Bet (devolve o stake em empate)", () => {
  it("empate no final devolve VOID (não WON nem LOST) — nunca antecipado", () => {
    const live = state({ homeScore: 1, awayScore: 1 });
    expect(evaluateSelection(footballAdapter, "Draw No Bet", "1", live).verdict).toBe("OPEN");
    const final = state({ homeScore: 1, awayScore: 1, finished: true });
    expect(evaluateSelection(footballAdapter, "Draw No Bet", "1", final)).toMatchObject({ verdict: "VOID", reason: "EVENT_FINISHED" });
  });
});

describe("Settlement Engine — mercado desconhecido/handicap fica para revisão", () => {
  it("handicap nunca é reconhecido (formato não confirmado) — UNRESOLVABLE mesmo no final", () => {
    const s = state({ homeScore: 2, awayScore: 0, finished: true });
    expect(evaluateSelection(footballAdapter, "Asian Handicap", "Home -1.5", s)).toMatchObject({ verdict: "UNRESOLVABLE", reason: null });
  });
});

describe("Settlement Engine — desportos adiados (ténis/voleibol/F1/MMA)", () => {
  it("nunca liquida nada, mesmo no final do evento", () => {
    for (const sport of ["tennis", "volleyball", "formula1", "mma"] as const) {
      const adapter = getSettlementAdapter(sport);
      const s = state({ homeScore: 2, awayScore: 0, finished: true });
      expect(evaluateSelection(adapter, "Match Winner", "1", s)).toMatchObject({ verdict: "UNRESOLVABLE" });
    }
  });
});

describe("Settlement Engine — cantos/cartões usam as mesmas regras de Over/Under", () => {
  it("cantos: liquida antecipado quando total já ultrapassa a linha", () => {
    const s = state({ homeScore: 0, awayScore: 0, homeCorners: 5, awayCorners: 5 });
    expect(evaluateSelection(footballAdapter, "Total Corners", "Over 8.5", s)).toMatchObject({ verdict: "WON", reason: "UNAMBIGUOUS_OUTCOME" });
  });

  it("cartões: sem dados de cartões, fica OPEN em direto e UNRESOLVABLE no final", () => {
    const live = state({ homeScore: 0, awayScore: 0 });
    expect(evaluateSelection(footballAdapter, "Total Cards", "Over 3.5", live).verdict).toBe("OPEN");
    const final = state({ homeScore: 0, awayScore: 0, finished: true });
    expect(evaluateSelection(footballAdapter, "Total Cards", "Over 3.5", final)).toMatchObject({ verdict: "UNRESOLVABLE" });
  });
});
