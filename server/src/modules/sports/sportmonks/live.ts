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
// A documentação oficial da Sportmonks recomenda pedir a cada 1-2s para livescores (atraso máximo
// ~2s). Não se vai tão longe aqui de propósito: a resposta real de /livescores/inplay confirma que
// este endpoint está debaixo do MESMO balde de limite ("requested_entity": "Fixture") que
// fetchFixturesBetween() usado pelo pré-jogo (sportmonks/prematch.ts, até 8 pedidos a cada 40s) —
// os dois partilham a mesma quota horária. A 5s, este poller sozinho fica em ~720 pedidos/hora;
// somado ao pior caso do pré-jogo (~720/hora), dá ~1440/hora — folgado mesmo debaixo do limite
// "3000 pedidos por entidade por hora" documentado para o plano por omissão (a conta real mostrou
// muito mais margem que isso — 50000 chamadas no complemento em avaliação — mas fica-se pelo valor
// conservador documentado, sem confiar no que pode ser só um limite de avaliação temporário).
const POLL_INTERVAL_MS = 5_000;

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
