import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { splitStakeForBonus, betQualifiesForRollover } from "@/modules/promotions/service";

const D = (v: number | string) => new Prisma.Decimal(v);

describe("splitStakeForBonus — saldo promocional gasto primeiro", () => {
  it("stake cabe todo no saldo promocional: tudo vem do bónus", () => {
    const { bonusPortion, realPortion } = splitStakeForBonus(D(5), D(20));
    expect(bonusPortion.toNumber()).toBe(5);
    expect(realPortion.toNumber()).toBe(0);
  });

  it("stake maior que o saldo promocional: bónus até esgotar, resto do saldo real", () => {
    const { bonusPortion, realPortion } = splitStakeForBonus(D(30), D(20));
    expect(bonusPortion.toNumber()).toBe(20);
    expect(realPortion.toNumber()).toBe(10);
  });

  it("sem saldo promocional: tudo vem do saldo real", () => {
    const { bonusPortion, realPortion } = splitStakeForBonus(D(10), D(0));
    expect(bonusPortion.toNumber()).toBe(0);
    expect(realPortion.toNumber()).toBe(10);
  });

  it("nunca deixa bonusPortion negativo mesmo com bonusBalance negativo (defensivo)", () => {
    const { bonusPortion, realPortion } = splitStakeForBonus(D(10), D(-5));
    expect(bonusPortion.toNumber()).toBe(0);
    expect(realPortion.toNumber()).toBe(10);
  });

  it("stake exatamente igual ao saldo promocional: bónus zera, real fica 0", () => {
    const { bonusPortion, realPortion } = splitStakeForBonus(D(20), D(20));
    expect(bonusPortion.toNumber()).toBe(20);
    expect(realPortion.toNumber()).toBe(0);
  });
});

describe("betQualifiesForRollover — odd mínima + desporto elegível", () => {
  const promoAllSports = { eligibleSports: [] as string[] };
  const promoFootballOnly = { eligibleSports: ["football"] };

  it("odd abaixo da mínima nunca qualifica, mesmo com desporto elegível", () => {
    const ok = betQualifiesForRollover({ minOdd: D("1.50") }, promoAllSports, D("1.40"), ["football"]);
    expect(ok).toBe(false);
  });

  it("odd igual à mínima qualifica (limite inclusivo)", () => {
    const ok = betQualifiesForRollover({ minOdd: D("1.50") }, promoAllSports, D("1.50"), ["football"]);
    expect(ok).toBe(true);
  });

  it("odd acima da mínima e desportos elegíveis vazio (todos passam) qualifica", () => {
    const ok = betQualifiesForRollover({ minOdd: D("1.50") }, promoAllSports, D("2.10"), ["tennis"]);
    expect(ok).toBe(true);
  });

  it("desporto fora da lista de elegíveis não qualifica", () => {
    const ok = betQualifiesForRollover({ minOdd: D("1.50") }, promoFootballOnly, D("2.10"), ["tennis"]);
    expect(ok).toBe(false);
  });

  it("múltipla com um leg de desporto não elegível: reprova mesmo com o resto elegível", () => {
    const ok = betQualifiesForRollover({ minOdd: D("1.50") }, promoFootballOnly, D("3.00"), ["football", "tennis"]);
    expect(ok).toBe(false);
  });

  it("múltipla com todos os legs de desportos elegíveis qualifica", () => {
    const promoFootballAndTennis = { eligibleSports: ["football", "tennis"] };
    const ok = betQualifiesForRollover({ minOdd: D("1.50") }, promoFootballAndTennis, D("3.00"), ["football", "tennis"]);
    expect(ok).toBe(true);
  });
});
