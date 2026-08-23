import { describe, it, expect } from "vitest";
import { resolveBetSelectionOutcome } from "@/modules/betting/settlementRules";

const STATS = { homeScore: 1, awayScore: 1 };

describe("resolveBetSelectionOutcome — Dupla Hipótese", () => {
  // Formato real confirmado em produção (ver web/app.js::translateSelectionLabel): a Pulsescore
  // manda "<Equipa> and Draw" / "<Equipa1> and <Equipa2>", não o formato compacto "1X"/"X2"/"12".
  // Antes desta correção, NENHUMA aposta real de Dupla Hipótese conseguia liquidar sozinha.
  it("'<Equipa Casa> and Draw' GANHA quando a casa vence ou empata", () => {
    const r = resolveBetSelectionOutcome(
      { market: "Double Chance", selection: "Lechia Zielona Gora and Draw", home: "Lechia Zielona Gora", away: "Hutnik Krakow" },
      { homeScore: 2, awayScore: 1 }
    );
    expect(r).toBe("WON");
  });

  it("'<Equipa Fora> and Draw' PERDE quando a casa vence", () => {
    const r = resolveBetSelectionOutcome(
      { market: "Double Chance", selection: "Hutnik Krakow and Draw", home: "Lechia Zielona Gora", away: "Hutnik Krakow" },
      { homeScore: 2, awayScore: 1 }
    );
    expect(r).toBe("LOST");
  });

  it("'<Equipa1> and <Equipa2>' (sem empate) GANHA em qualquer resultado exceto empate", () => {
    const r = resolveBetSelectionOutcome(
      { market: "Double Chance", selection: "Lechia Zielona Gora and Hutnik Krakow", home: "Lechia Zielona Gora", away: "Hutnik Krakow" },
      STATS
    );
    expect(r).toBe("LOST"); // 1-1 é empate — "12" perde
  });

  it("continua a aceitar o formato compacto '1X'/'X2'/'12'", () => {
    expect(resolveBetSelectionOutcome({ market: "Double Chance", selection: "1X", home: "A", away: "B" }, { homeScore: 1, awayScore: 0 })).toBe("WON");
    expect(resolveBetSelectionOutcome({ market: "Double Chance", selection: "X2", home: "A", away: "B" }, { homeScore: 1, awayScore: 0 })).toBe("LOST");
  });
});

describe("resolveBetSelectionOutcome — Resultado Exato", () => {
  it("aceita hífen normal", () => {
    expect(resolveBetSelectionOutcome({ market: "Correct Score", selection: "2-1", home: "A", away: "B" }, { homeScore: 2, awayScore: 1 })).toBe("WON");
  });

  it("aceita en-dash (reportado numa amostra real: '2 – 1')", () => {
    expect(resolveBetSelectionOutcome({ market: "Correct Score", selection: "2 – 1", home: "A", away: "B" }, { homeScore: 2, awayScore: 1 })).toBe("WON");
    expect(resolveBetSelectionOutcome({ market: "Correct Score", selection: "3 – 1", home: "A", away: "B" }, { homeScore: 2, awayScore: 1 })).toBe("LOST");
  });
});

describe("resolveBetSelectionOutcome — BTTS nunca liquida seleções que não sejam Sim/Não", () => {
  // Caso real reportado: um mercado cujo nome bruto continha "Both Teams To Score" por
  // coincidência mas cujas seleções eram na verdade equipa/empate/equipa (não Sim/Não) — o motor
  // de liquidação já era seguro (cai em UNRESOLVABLE em vez de pagar mal); este teste bloqueia
  // uma regressão futura.
  it("seleções equipa/empate/equipa sob um mercado classificado como BTTS ficam UNRESOLVABLE", () => {
    const r = resolveBetSelectionOutcome(
      { market: "Both Teams To Score", selection: "Lechia Zielona Gora", home: "Lechia Zielona Gora", away: "Hutnik Krakow" },
      STATS
    );
    expect(r).toBe("UNRESOLVABLE");
  });

  it("Sim/Não continuam a liquidar normalmente", () => {
    expect(resolveBetSelectionOutcome({ market: "Both Teams To Score", selection: "Yes", home: "A", away: "B" }, STATS)).toBe("WON");
    expect(resolveBetSelectionOutcome({ market: "Both Teams To Score", selection: "No", home: "A", away: "B" }, STATS)).toBe("LOST");
  });
});
