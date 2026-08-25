import { logger } from "../../../lib/logger";
import { hybridSportsService } from "../hybridService";
import type { LiveEvent } from "../types";
import { fetchInplayOddsForFixture, fetchLivescoresInplay, normalizeLiveFixture } from "./client";

/**
 * Poller de Ao Vivo de futebol via Sportmonks (só ativo com FOOTBALL_PROVIDER=sportmonks, ver
 * server.ts) — substitui a Pulsescore/WebSocket para "football" nesse modo (ver hybridService.ts
 * e wsClient.ts, que passam a ignorar futebol quando o interruptor está ligado, para as duas
 * fontes não ficarem a substituir o snapshot uma da outra).
 *
 * Usa GET /livescores/inplay (fetchLivescoresInplay, ver client.ts) para placar/relógio, e
 * GET /odds/inplay/fixtures/{id} (fetchInplayOddsForFixture) para as odds de cada jogo — os dois
 * CONFIRMADOS por amostras reais a atualizar durante o jogo (ao contrário de fetchFixturesBetween/
 * fetchFixtureDetail, cujas odds confirmaram-se congeladas desde antes do apito inicial — ver
 * diagnoseLiveOddsMovement() em client.ts, reportado pelo utilizador como "odds não atualizam").
 * Sem odds para um jogo específico (pedido individual falhou), esse jogo aparece com placar/
 * relógio mas sem mercados, em vez de ficar escondido — nunca inventa odds.
 *
 * Alimenta hybridSportsService.applyExternalSnapshot("football", events) — o mesmo ponto de
 * entrada usado pela Pulsescore, por isso o WebSocket gateway e a liquidação automática de apostas
 * (server.ts, ligados aos eventos 'event'/'remove') continuam a funcionar sem alterações: um jogo
 * que desaparece de /livescores/inplay (porque terminou) é tratado exatamente como um jogo que
 * desaparece de um snapshot da Pulsescore — remove com a mesma margem (REMOVE_GRACE_MS), liquidando
 * as apostas com o último placar conhecido.
 */
// Um pedido de odds por jogo ao vivo (não em lote — /odds/inplay sem filtro por fixture nunca foi
// confirmado por amostra real) — por isso o intervalo aqui é maior do que só o placar precisaria:
// com N jogos ao vivo em simultâneo, cada ciclo gasta N+1 pedidos (1 de /livescores/inplay + N de
// odds), todos no mesmo balde de limite que fetchFixturesBetween() do pré-jogo (ver aviso em
// sportmonks/prematch.ts). A 15s, com um pico razoável de N=8 jogos ao vivo, fica-se por
// ~(3600/15)*9 = 2160 pedidos/hora só aqui — somado ao pior caso do pré-jogo (~1440/hora), dá
// ~3600/hora no pior cenário, por isso 15s (não menos) é a escolha conservadora face ao limite
// documentado de 3000/hora por entidade (a conta real mostrou muita mais margem, mas não se confia
// nisso — pode ser só quota de avaliação temporária).
const POLL_INTERVAL_MS = 15_000;

async function pollOnce() {
  try {
    const fixtures = await fetchLivescoresInplay();
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
    logger.warn({ err: String(err).slice(0, 200) }, "Sportmonks: falha ao obter /livescores/inplay — mantém o último snapshot de Ao Vivo");
  }
}

export function startSportmonksLiveFootballPoll(): void {
  void pollOnce();
  setInterval(pollOnce, POLL_INTERVAL_MS);
}
