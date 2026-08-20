import { EventEmitter } from "events";
import { env } from "../../config/env";
import { logger } from "../../lib/logger";
import { fetchLiveEvents, fetchLiveSportsWithEvents } from "./pulsescore/client";
import { pulsescoreWs } from "./pulsescore/wsClient";
import { getFixtureStatistics } from "./apifootball/client";
import { resolveFixtureForEvent } from "./mapping/service";
import { ALL_SPORTS, type LiveEvent, type Sport } from "./types";

const POLL_INTERVAL_MS = 25_000;

/**
 * Sistema híbrido: Pulsescore fornece odds/resultados ao vivo para futebol, ténis, basquete,
 * hóquei de gelo, MMA, beisebol, voleibol e Fórmula 1; API-Football enriquece com estatísticas
 * detalhadas sob pedido (só futebol). Mantém um snapshot em memória e reemite atualizações para
 * quem estiver subscrito (o gateway websocket interno consome estes eventos).
 *
 * Duas fontes, geridas juntas:
 *  - WebSocket real da Pulsescore (pulsescore/wsClient.ts, plano PRO/MAX/ULTRA) — cobre até 3
 *    desportos em simultâneo (os mais movimentados agora), com odds quase em tempo real e o
 *    placar ao vivo (`score`), que a REST não devolve.
 *  - Polling REST (pulsescore/client.ts, GET /live-events) — cobre os restantes desportos que
 *    não têm ligação WebSocket ativa neste momento, e é a única fonte se a conta não tiver
 *    plano com WebSocket (nesse caso o wsClient simplesmente nunca liga a nada).
 * Cada ciclo de polling REST ignora os desportos já cobertos pelo WebSocket, para não haver
 * duas fontes a escrever por cima uma da outra. `applySportSnapshot()` é o ponto de entrada
 * comum a ambas — substitui todos os eventos de um desporto de uma vez (adiciona/atualiza os
 * atuais, remove os que já não vierem), portanto tanto um frame de WebSocket como um ciclo de
 * polling REST mantêm o estado correto sem lógica duplicada.
 * Sem PULSESCORE_API_KEY, ou se a Pulsescore não devolver nada ao vivo, a lista fica
 * simplesmente vazia — nunca se inventam eventos/odds fictícios num sistema de apostas real.
 */
class HybridSportsService extends EventEmitter {
  private events = new Map<string, LiveEvent>();

  start() {
    if (!env.PULSESCORE_API_KEY) {
      logger.warn("Sports: PULSESCORE_API_KEY não configurada — feed Ao Vivo ficará sempre vazio");
      return;
    }
    pulsescoreWs.on("snapshot", ({ sport, events }: { sport: Sport; events: LiveEvent[] }) => {
      this.applySportSnapshot(sport, events);
    });
    pulsescoreWs.start();

    this.pollOnce();
    setInterval(() => this.pollOnce(), POLL_INTERVAL_MS);
  }

  private async pollOnce() {
    const wsCovered = pulsescoreWs.activeSports();
    const live = new Set<Sport>();

    try {
      const liveSports = await fetchLiveSportsWithEvents();
      for (const sport of liveSports) live.add(sport);
      live.add("formula1"); // bookmaker diferente (unibetau), não aparece em /live-events/sports
      live.add("baseball"); // bookmaker diferente (bet365), o summary da paddypower não é fiável para ele

      for (const sport of live) {
        if (wsCovered.has(sport)) continue; // já coberto pelo WebSocket, REST duplicaria
        try {
          const events = await fetchLiveEvents(sport, { maxPages: 2 });
          this.applySportSnapshot(sport, events);
        } catch (err) {
          logger.warn({ err, sport }, "Pulsescore: falha ao obter eventos ao vivo para este desporto");
        }
      }
    } catch (err) {
      logger.warn({ err }, "Pulsescore: falha ao obter live-events/sports");
    }

    // Desportos sem eventos ao vivo agora (nem via REST nem via WebSocket) ficam vazios.
    for (const sport of ALL_SPORTS) {
      if (!live.has(sport) && !wsCovered.has(sport)) this.applySportSnapshot(sport, []);
    }
  }

  /** Substitui todos os eventos de um desporto de uma vez — usado tanto pelo polling REST
   * (um desporto por chamada) como por cada frame do WebSocket (todos os eventos ao vivo
   * desse desporto naquele instante). Um evento que desaparece de um snapshot (jogo terminado,
   * ou já não devolvido pela Pulsescore por qualquer razão) tem de ser removido tão depressa
   * quanto o próximo ciclo de polling/frame WS — sem isto o gateway (ver websocket/gateway.ts)
   * nunca avisava o frontend, que ficava com o jogo preso na página Ao Vivo indefinidamente.
   */
  private applySportSnapshot(sport: Sport, events: LiveEvent[]) {
    const incomingIds = new Set(events.map((e) => e.id));
    for (const [id, evt] of this.events) {
      if (evt.sport === sport && !incomingIds.has(id)) {
        this.events.delete(id);
        this.emit("remove", id);
      }
    }
    for (const evt of events) this.ingest(evt);
  }

  private ingest(evt: LiveEvent) {
    this.events.set(evt.id, evt);
    this.emit("event", evt);
  }

  snapshot(sport?: Sport): LiveEvent[] {
    const all = [...this.events.values()];
    return sport ? all.filter((e) => e.sport === sport) : all;
  }

  getById(id: string): LiveEvent | undefined {
    return this.events.get(id);
  }

  /**
   * Estatísticas detalhadas por equipa via API-Football (só futebol) — resolve o fixture pelo
   * motor de mapeamento persistente (mapping/service.ts::resolveFixtureForEvent, ver
   * docs/TEAM_MAPPING.md) em vez de pesquisar as equipas pelo nome a cada pedido.
   */
  async getStatistics(eventId: string) {
    const event = this.events.get(eventId);
    if (!event || event.sport !== "football") return null;
    const resolved = await resolveFixtureForEvent(event);
    if (!resolved) return null;
    return getFixtureStatistics(resolved.fixtureId);
  }
}

export const hybridSportsService = new HybridSportsService();
