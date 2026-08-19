import { EventEmitter } from "events";
import { env } from "../../config/env";
import { logger } from "../../lib/logger";
import { fetchEvents } from "./pulsescore/client";
import { mockSportsFeed } from "./mockFeed";
import { getFixtureStatistics } from "./apifootball/client";
import { ALL_SPORTS, type LiveEvent, type Sport } from "./types";

const POLL_INTERVAL_MS = 25_000;

/**
 * Sistema híbrido: Pulsescore fornece odds/resultados (REST, com polling — ver
 * pulsescore/client.ts para o porquê de não ser websocket) para futebol, ténis, basquete,
 * hóquei de gelo, beisebol, voleibol, Fórmula 1 e MMA; API-Football enriquece com
 * estatísticas detalhadas sob pedido (só futebol). Mantém um snapshot em memória e reemite
 * atualizações para quem estiver subscrito (o gateway websocket interno consome estes eventos).
 *
 * Cada ciclo de polling busca os 8 desportos e fica só com os eventos `live:true` — os
 * `live:false` (pré-jogo) alimentam o endpoint /api/sports/prematch, não este feed ao vivo.
 * Se nenhum desporto devolver eventos ao vivo reais (chave não configurada, provedor em baixo,
 * ou fora de horário de jogos), cai automaticamente para o feed simulado.
 */
class HybridSportsService extends EventEmitter {
  private events = new Map<string, LiveEvent>();
  private usingMock = false;

  start() {
    mockSportsFeed.on("update", (evt) => {
      if (this.usingMock) this.ingest(evt);
    });

    if (env.PULSESCORE_API_KEY) {
      this.pollOnce();
      setInterval(() => this.pollOnce(), POLL_INTERVAL_MS);
    } else {
      this.enableMock();
    }
  }

  private async pollOnce() {
    let anyLive = false;
    for (const sport of ALL_SPORTS) {
      try {
        const events = await fetchEvents(sport, { maxPages: 2 });
        const liveEvents = events.filter((e) => e.status === "live");
        if (liveEvents.length) anyLive = true;
        for (const evt of liveEvents) this.ingest(evt);
      } catch (err) {
        logger.warn({ err, sport }, "Pulsescore: falha ao obter eventos ao vivo para este desporto");
      }
    }
    if (anyLive) this.disableMock();
    else this.enableMock();
  }

  private enableMock() {
    if (this.usingMock || !env.SPORTS_DATA_MOCK_FALLBACK) return;
    logger.info("Sports: a usar feed simulado (sem eventos ao vivo reais da Pulsescore neste momento)");
    this.usingMock = true;
    for (const [id, evt] of this.events) if (evt.source === "pulsescore") this.events.delete(id);
    for (const evt of mockSportsFeed.snapshot()) this.ingest(evt);
    mockSportsFeed.start();
  }

  private disableMock() {
    if (!this.usingMock) return;
    logger.info("Sports: eventos ao vivo reais da Pulsescore disponíveis — a desligar o feed simulado");
    this.usingMock = false;
    mockSportsFeed.stop();
    for (const [id, evt] of this.events) if (evt.source === "mock") this.events.delete(id);
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

  /** Football-only statistics enrichment via API-Football, keyed by their fixture id. */
  async getStatistics(eventId: string) {
    const event = this.events.get(eventId);
    if (!event || event.sport !== "football" || !event.apiFootballFixtureId) return null;
    return getFixtureStatistics(event.apiFootballFixtureId);
  }
}

export const hybridSportsService = new HybridSportsService();
