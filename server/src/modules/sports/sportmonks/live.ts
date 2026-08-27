import { logger } from "../../../lib/logger";
import { hybridSportsService } from "../hybridService";
import type { LiveEvent, LiveOdds } from "../types";
import {
  fetchInplayOddsForFixture,
  fetchLatestLivescores,
  fetchLivescoresInplay,
  normalizeLiveFixture,
} from "./client";

/**
 * Poller de Ao Vivo de futebol via Sportmonks (só ativo com FOOTBALL_PROVIDER=sportmonks, ver
 * server.ts) — substitui a Pulsescore/WebSocket para "football" nesse modo.
 *
 * ARQUITETURA DE 2 CAMADAS (nova, 2026-08-26) — documentação oficial Sportmonks v3 confirma:
 *  • Scores atualizam ≤10s, Events 10–30s, Odds ao vivo cada 2–10s (ver API FAQ).
 *  • Endpoint /livescores/latest devolve apenas fixtures atualizadas nos últimos 10s, payload
 *    MUITO menor do que /inplay completo — permite polling a 1-2s só do essencial sem gastar
 *    cota desnecessária (o rate limit de 3000/hora do plano Pro, por exemplo, não aguentava
 *    /inplay + odds individuais todos a 2s — daria 8 jogos × 3600/2 ≈ 16200 pedidos/hora).
 *
 * CAMADA RÁPIDA (FAST_POLL_INTERVAL_MS = 2s) — placar, relógio, estado, eventos, motivo suspensão:
 *  • GET /livescores/latest (1 pedido por ciclo, só fixtures atualizadas recentemente)
 *  • NÃO pede odds. Publica no hybrid usando MERGE PARCIAL com o evento já existente (preserva
 *    as odds do último poll ODDS, nunca "apaga mercados" por causa de um ciclo rápido).
 *  • Quando /latest vem vazio (nenhuma atualização nos 10s anteriores — normal entre golos)
 *    não publica nada — o hybrid mantém o último snapshot completo.
 *
 * CAMADA LENTA (ODDS_POLL_INTERVAL_MS = 12s) — mercados (odds) de cada jogo:
 *  • GET /livescores/inplay para saber a lista de jogos ativos (1 pedido)
 *  • + N × GET /odds/inplay/fixtures/{id} (N = nº jogos ativos)
 *  • Publica o evento COMPLETO (odds incluídas) no hybrid — este é o ciclo que "renova" as
 *    odds de cada jogo a cada 12s (compatível com a frequência da Sportmonks de 2-10s).
 *
 * Ambos os ciclos publicam no mesmo channel "football" do hybrid, por isso:
 *  • O WebSocket gateway (gateway.ts ligado aos eventos 'event'/'remove') continua transparente.
 *  • A liquidação (checkEarlySettlement / settleEventFinished) recebe sempre o estado mais
 *    recente, sem qualquer alteração.
 *  • O REMOVE_GRACE_MS = 90s do hybrid é respeitado pelos dois ciclos.
 *
 * CONSUMO ESTIMADO (pico N=8 jogos ao vivo em simultâneo):
 *  • FAST 2s:    3600/2 × 1   = 1800 pedidos/hora
 *  • ODDS 12s:  3600/12 × (1+8) = 2700 pedidos/hora
 *  • TOTAL:      ~4500/h  — ok para Enterprise (5000/h). Para Pro (3000/h) recomendamos
 *    aumentar FAST_POLL_INTERVAL_MS para 3s (fica 1200+2700 = 3900 — ligeiramente acima) ou
 *    ODDS para 15s (1800+2160 = 3960) OU ativar modo "odds on-demand" só quando há viewers
 *    WS numa fixture.
 *  • Pré-jogo adicional ~3600/h (ver prematch.ts) é contado separadamente na entidade
 *    "fixtures" do rate limit per entity (Sportmonks cobra por entidade, não global).
 */
const FAST_POLL_INTERVAL_MS = 2_000;
const ODDS_POLL_INTERVAL_MS = 12_000;

const FULL_TIME_STATE_ID = 5; // CONFIRMADO por amostras reais (state_id=5 = FT/Full Time)

/**
 * Normaliza uma fixture para LiveEvent MAS sem odds — usado pelo poll rápido. Devolve um
 * objeto "fraco" com odds.length=0, mas antes de publicar no hybrid fazemos MERGE com o
 * evento já existente (se existir) para não perder as odds do último poll de ODDS.
 */
function normalizeFastFixture(fixture: any): LiveEvent | null {
  const empty: LiveOdds[] = [];
  return normalizeLiveFixture(fixture, empty);
}

/**
 * Publica "fast updates" (só scores/estado) SEM remover eventos do desporto que NÃO aparecem
 * no payload de /latest. /latest é INCREMENTAL (só atualizações últimos 10s), não é um
 * snapshot completo — por isso NÃO podemos chamar applyExternalSnapshot() (que compara IDs e
 * marca todos os faltantes como "missingSince", removendo ao fim de REMOVE_GRACE_MS todos os
 * jogos que simplesmente não mudaram nada entre golos).
 *
 * Estratégia correta: para cada evento do /latest:
 *   1. Preservar odds do evento existente no hybrid (poll ODDS é o dono das odds);
 *   2. Ingerir INDIVIDUALMENTE (ingest = set + emit event), cada um por si;
 *   3. Nunca tocar nos outros IDs. O poll ODDS (12s) continua a ser o único que corre a
 *      limpeza de jogos terminados via applyExternalSnapshot completo.
 */
function publishFastUpdates(freshFastFixtures: LiveEvent[]) {
  for (const evt of freshFastFixtures) {
    const existing = hybridSportsService.getById(evt.id);
    const merged: LiveEvent =
      existing && existing.odds.length > 0
        ? { ...evt, odds: existing.odds, suspendedReason: evt.suspendedReason ?? existing.suspendedReason }
        : evt;
    // ingest = events.set + emit 'event' (ver hybridService.ts ingest())
    (hybridSportsService as any).ingest(merged);
  }
}

// --- Poll FAST (2s) — só scores/estado, via /latest (atualizados últimos 10s) ---
async function pollFastOnce() {
  try {
    const latestFixtures = await fetchLatestLivescores();
    // /latest NÃO garante que lista completa de jogos ao vivo — só os que mudaram. Por NÃO
    // ser snapshot completo, NÃO filtramos state_id aqui (se um jogo ficou FT há 2min e não
    // mudou mais, simplesmente não aparece em /latest — o poll ODDS (cada 12s) é que trata
    // de realmente o remover do hybrid através do /inplay completo). Também não filtramos
    // por "no changes" — /latest já vem com filtro aplicado na origem.
    if (!latestFixtures.length) return; // sem atualizações: não publica nada, não toca no estado

    const events: LiveEvent[] = [];
    for (const f of latestFixtures) {
      const evt = normalizeFastFixture(f);
      if (evt) events.push(evt);
    }
    if (events.length) publishFastUpdates(events);
  } catch (err) {
    // Não loggar a warning em cada falha (faz spam se Sportmonks tiver 1min de 503).
    // Mantém silencioso; o poll ODDS completo funciona como fallback para recuperação.
    logger.debug({ err: String(err).slice(0, 200) }, "Sportmonks: poll FAST /latest falhou — mantém estado (fallback via poll ODDS completo)");
  }
}

// --- Poll ODDS (12s) — lista completa via /inplay + odds individuais por fixture ---
async function pollOddsOnce() {
  try {
    const allFixtures = await fetchLivescoresInplay();
    const fixtures = allFixtures.filter((f) => f.state_id !== FULL_TIME_STATE_ID);
    const oddsResults = await Promise.allSettled(fixtures.map((f) => fetchInplayOddsForFixture(f.id)));
    const events: LiveEvent[] = [];
    fixtures.forEach((fixture, i) => {
      const oddsResult = oddsResults[i]!;
      if (oddsResult.status === "rejected") {
        logger.warn({ err: String(oddsResult.reason).slice(0, 200), fixtureId: fixture.id }, "Sportmonks: falha ao obter odds ao vivo (inplay) para um jogo — fica sem mercados neste ciclo");
      }
      const odds = oddsResult.status === "fulfilled" ? oddsResult.value : [];
      const evt = normalizeLiveFixture(fixture, odds);
      if (evt) events.push(evt);
    });
    hybridSportsService.applyExternalSnapshot("football", events);
  } catch (err) {
    logger.warn({ err: String(err).slice(0, 200) }, "Sportmonks: falha ao obter /livescores/inplay completo — mantém o último snapshot de Ao Vivo");
  }
}

export function startSportmonksLiveFootballPoll(): void {
  // Boot: primeiro o poll ODDS completo (para a lista de jogos e as odds iniciais aparecerem
  // sem esperar 12s), e só depois arrancamos o FAST a 2s (para já ter algo para preservar
  // as odds no merge). Ordem é importante.
  void pollOddsOnce().then(() => {
    setInterval(pollFastOnce, FAST_POLL_INTERVAL_MS);
    setInterval(pollOddsOnce, ODDS_POLL_INTERVAL_MS);
  });
}
