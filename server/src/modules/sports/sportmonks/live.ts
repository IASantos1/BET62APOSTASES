import { logger } from "../../../lib/logger";
import { hybridSportsService } from "../hybridService";
import type { LiveEvent } from "../types";
import { fetchLivescoresInplay, normalizeLiveFixture } from "./client";
import { getSportmonksEventById } from "./prematch";

/**
 * Poller de Ao Vivo de futebol via Sportmonks (só ativo com FOOTBALL_PROVIDER=sportmonks, ver
 * server.ts) — substitui a Pulsescore/WebSocket para "football" nesse modo (ver hybridService.ts
 * e wsClient.ts, que passam a ignorar futebol quando o interruptor está ligado, para as duas
 * fontes não ficarem a substituir o snapshot uma da outra).
 *
 * Usa GET /livescores/inplay (fetchLivescoresInplay, ver client.ts) para placar/relógio — CONFIRMADO
 * por uma amostra real completa — e vai buscar as odds de cada jogo ao cache já existente do
 * pré-jogo (getSportmonksEventById, prematch.ts), que já confirmou trazer odds mesmo para jogos já
 * começados. Sem correspondência aí (cache ainda não atualizou, ou o jogo saiu da janela de 5
 * dias), o jogo aparece com placar/relógio mas sem mercados, em vez de ficar escondido — nunca
 * inventa odds.
 *
 * Alimenta hybridSportsService.applyExternalSnapshot("football", events) — o mesmo ponto de
 * entrada usado pela Pulsescore, por isso o WebSocket gateway e a liquidação automática de apostas
 * (server.ts, ligados aos eventos 'event'/'remove') continuam a funcionar sem alterações: um jogo
 * que desaparece de /livescores/inplay (porque terminou) é tratado exatamente como um jogo que
 * desaparece de um snapshot da Pulsescore — remove com a mesma margem (REMOVE_GRACE_MS), liquidando
 * as apostas com o último placar conhecido.
 */
const POLL_INTERVAL_MS = 20_000; // um pouco mais frequente que os 25s da Pulsescore — cobre só futebol

async function pollOnce() {
  try {
    const fixtures = await fetchLivescoresInplay();
    const events: LiveEvent[] = [];
    for (const fixture of fixtures) {
      const cached = getSportmonksEventById(`sportmonks:${fixture.id}`);
      const evt = normalizeLiveFixture(fixture, cached?.odds ?? []);
      if (evt) events.push(evt);
    }
    hybridSportsService.applyExternalSnapshot("football", events);
  } catch (err) {
    logger.warn({ err: String(err).slice(0, 200) }, "Sportmonks: falha ao obter /livescores/inplay — mantém o último snapshot de Ao Vivo");
  }
}

export function startSportmonksLiveFootballPoll(): void {
  void pollOnce();
  setInterval(pollOnce, POLL_INTERVAL_MS);
}
