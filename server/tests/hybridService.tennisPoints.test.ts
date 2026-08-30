import { describe, it, expect } from "vitest";
import { mergeTransientTennisScore } from "@/modules/sports/hybridService";
import type { LiveEvent } from "@/modules/sports/types";

function tennisEvent(overrides: Partial<LiveEvent> = {}): LiveEvent {
  return {
    id: "pulsescore:1",
    sport: "tennis",
    league: "World Tennis. Mar del Plata",
    home: "Gonzalo Villanueva",
    away: "Vito Antonio Darderi",
    minuteOrPeriod: "Set 2",
    status: "live",
    odds: [],
    updatedAt: new Date().toISOString(),
    source: "pulsescore",
    statistics: { home: {}, away: {}, sets: { home: [6, 4], away: [4, 3] } },
    ...overrides,
  };
}

describe("mergeTransientTennisScore", () => {
  it("mantém o ponto anterior quando o novo frame reporta um rank de ponto mais baixo dentro do MESMO game (feed inconsistente)", () => {
    const previous = tennisEvent({ homeScore: "40", awayScore: "30" });
    const incoming = tennisEvent({ homeScore: "30", awayScore: "30" });
    const merged = mergeTransientTennisScore(previous, incoming);
    expect(merged.homeScore).toBe("40");
    expect(merged.awayScore).toBe("30");
  });

  // ⚠️ Bug real corrigido (2026-08-27): reportado como "ténis com atraso de ~30s a atualizar a
  // pontuação" apesar do WebSocket da Pulsescore mandar um frame por segundo. "0"-"0" genuíno de
  // início de um NOVO GAME dentro do MESMO set (minuteOrPeriod e sets não mudam a meio de um set)
  // tem sempre rank 0+0=0, sempre menor que o que ficou no fim do game anterior — sem este caso
  // especial, o placar ficava PRESO no último ponto do game anterior até o novo game (por
  // coincidência) alcançar de novo uma soma de rank igual ou maior, o que podia demorar quase um
  // game inteiro (~20-40s reais de ténis).
  it("ACEITA um 0-0 genuíno de início de game novo, mesmo com rank mais baixo que o anterior", () => {
    const previous = tennisEvent({ homeScore: "40", awayScore: "30" }); // fim do game anterior
    const incoming = tennisEvent({ homeScore: "0", awayScore: "0" }); // início do game seguinte, mesmo set
    const merged = mergeTransientTennisScore(previous, incoming);
    expect(merged.homeScore).toBe("0");
    expect(merged.awayScore).toBe("0");
  });

  it("aceita sempre um rank de ponto mais alto (progresso normal dentro do mesmo game)", () => {
    const previous = tennisEvent({ homeScore: "15", awayScore: "0" });
    const incoming = tennisEvent({ homeScore: "30", awayScore: "0" });
    const merged = mergeTransientTennisScore(previous, incoming);
    expect(merged.homeScore).toBe("30");
    expect(merged.awayScore).toBe("0");
  });

  it("aceita imediatamente quando o set muda (novo set, mesmo minuteOrPeriod não bate)", () => {
    const previous = tennisEvent({ homeScore: "40", awayScore: "30", minuteOrPeriod: "Set 2" });
    const incoming = tennisEvent({
      homeScore: "0",
      awayScore: "0",
      minuteOrPeriod: "Set 3",
      statistics: { home: {}, away: {}, sets: { home: [6, 4, 0], away: [4, 6, 0] } },
    });
    const merged = mergeTransientTennisScore(previous, incoming);
    expect(merged.homeScore).toBe("0");
    expect(merged.awayScore).toBe("0");
  });

  it("aceita imediatamente quando os jogos fechados do set mudam (novo game terminou, sets.home/away atualizados)", () => {
    const previous = tennisEvent({ homeScore: "40", awayScore: "AD", statistics: { home: {}, away: {}, sets: { home: [6, 4], away: [4, 3] } } });
    const incoming = tennisEvent({ homeScore: "0", awayScore: "0", statistics: { home: {}, away: {}, sets: { home: [6, 4], away: [4, 4] } } });
    const merged = mergeTransientTennisScore(previous, incoming);
    expect(merged.homeScore).toBe("0");
    expect(merged.awayScore).toBe("0");
  });

  it("não mexe em nada quando não há evento anterior (primeiro frame deste jogo)", () => {
    const incoming = tennisEvent({ homeScore: "15", awayScore: "0" });
    const merged = mergeTransientTennisScore(undefined, incoming);
    expect(merged).toBe(incoming);
  });

  it("nunca aplica a desportos que não sejam ténis", () => {
    const previous: LiveEvent = {
      id: "pulsescore:2", sport: "football", league: "L", home: "A", away: "B", minuteOrPeriod: "60'",
      status: "live", odds: [], updatedAt: new Date().toISOString(), source: "pulsescore", homeScore: 2, awayScore: 1,
    };
    const incoming: LiveEvent = { ...previous, homeScore: 1, awayScore: 1 };
    const merged = mergeTransientTennisScore(previous, incoming);
    expect(merged.homeScore).toBe(1);
    expect(merged.awayScore).toBe(1);
  });
});
