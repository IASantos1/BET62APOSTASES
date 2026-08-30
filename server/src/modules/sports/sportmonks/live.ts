import { logger } from "../../../lib/logger";
import { hybridSportsService } from "../hybridService";
import type { LiveEvent, LiveOdds } from "../types";
import { fetchInplayOddsForFixture, fetchLatestLivescores, fetchLivescoresInplay, normalizeLiveFixture } from "./client";

/**
 * Poller de Ao Vivo de futebol via Sportmonks — reescrito do zero (2026-08-27), mesma
 * arquitetura de 2 camadas já validada em produção (documentação oficial Sportmonks v3: scores
 * atualizam ≤10s, events 10-30s, odds ao vivo 2-10s):
 *
 *  CAMADA RÁPIDA (2s) — só placar/relógio/estado, via GET /livescores/latest (payload pequeno,
 *  só fixtures atualizadas nos últimos 10s). Faz merge PARCIAL com o evento já existente
 *  (preserva as odds do último poll ODDS — /latest nunca as traz).
 *
 *  CAMADA LENTA (12s) — mercados (odds), via GET /livescores/inplay (lista completa) +
 *  GET /odds/inplay/fixtures/{id} por jogo. Publica o snapshot COMPLETO (remove jogos terminados).
 *
 * Consumo estimado no pico (8 jogos ao vivo): ~1800 pedidos/h (rápida) + ~2700 pedidos/h (lenta)
 * = ~4500/h, dentro do plano Enterprise (5000/h); ajustar os intervalos abaixo se o plano for
 * menor (Pro: 3000/h).
 */
const FAST_POLL_INTERVAL_MS = 2_000;
const ODDS_POLL_INTERVAL_MS = 12_000;
const FULL_TIME_STATE_ID = 5; // CONFIRMADO por amostra real (state_id=5 = FT/Full Time)

async function pollFastOnce() {
  try {
    const latestFixtures = await fetchLatestLivescores();
    if (!latestFixtures.length) return; // sem atualizações nos últimos 10s — não publica nada
    for (const fixture of latestFixtures) {
      const evt = normalizeLiveFixture(fixture, [] as LiveOdds[]);
      if (!evt) continue;
      const existing = hybridSportsService.getById(evt.id);
      const merged: LiveEvent =
        existing && existing.odds.length > 0
          ? { ...evt, odds: existing.odds, suspendedReason: evt.suspendedReason ?? existing.suspendedReason }
          : evt;
      hybridSportsService.ingestPartialUpdate(merged);
    }
  } catch (err) {
    // Sem aviso a cada falha (spam se a Sportmonks tiver um minuto de 503) — o poll ODDS
    // completo, abaixo, funciona como recuperação automática.
    logger.debug({ err: String(err).slice(0, 200) }, "Sportmonks: poll rápido (/latest) falhou — mantém estado");
  }
}

async function pollOddsOnce() {
  try {
    const allFixtures = await fetchLivescoresInplay();
    const fixtures = allFixtures.filter((f) => f.state_id !== FULL_TIME_STATE_ID);
    const oddsResults = await Promise.allSettled(fixtures.map((f) => fetchInplayOddsForFixture(f.id)));
    const events: LiveEvent[] = [];
    fixtures.forEach((fixture, i) => {
      const oddsResult = oddsResults[i]!;
      if (oddsResult.status === "rejected") {
        logger.warn({ err: String(oddsResult.reason).slice(0, 200), fixtureId: fixture.id }, "Sportmonks: falha ao obter odds ao vivo de um jogo — mantém odds anteriores");
      }
      const existing = hybridSportsService.getById(`sportmonks:${fixture.id}`);
      const odds = oddsResult.status === "fulfilled" ? oddsResult.value : (existing?.odds ?? []);
      const evt = normalizeLiveFixture(fixture, odds);
      if (evt) events.push(evt);
    });
    hybridSportsService.applyExternalSnapshot("football", events);
  } catch (err) {
    logger.warn({ err: String(err).slice(0, 200) }, "Sportmonks: falha ao obter /livescores/inplay — mantém o último snapshot Ao Vivo");
  }
}

export function startSportmonksLiveFootballPoll(): void {
  // Arranca com o poll ODDS completo primeiro (lista de jogos + odds iniciais sem esperar 12s),
  // só depois liga o poll rápido — precisa de já haver algo no hybrid para fazer o merge parcial.
  void pollOddsOnce().then(() => {
    setInterval(pollFastOnce, FAST_POLL_INTERVAL_MS);
    setInterval(pollOddsOnce, ODDS_POLL_INTERVAL_MS);
  });
}
