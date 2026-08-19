import { EventEmitter } from "events";
import { env } from "../../config/env";
import { logger } from "../../lib/logger";
import { pulsescoreClient } from "./pulsescore/client";
import { mockSportsFeed } from "./mockFeed";
import { getFixtureStatistics } from "./apifootball/client";
import type { LiveEvent, Sport } from "./types";

/**
 * Sistema híbrido: Pulsescore fornece odds/resultados ao vivo via websocket (futebol, ténis,
 * basquete); API-Football enriquece com estatísticas detalhadas sob pedido (só futebol, que é
 * o que a API-Football cobre). Mantém um snapshot em memória e reemite atualizações para
 * quem estiver subscrito (o gateway websocket interno consome estes eventos).
 */
class HybridSportsService extends EventEmitter {
  private events = new Map<string, LiveEvent>();
  private usingMock = false;

  start() {
    if (env.PULSESCORE_API_KEY) {
      pulsescoreClient.on("update", (evt) => this.ingest(evt));
      pulsescoreClient.on("status", (status) => {
        if (status === "unavailable" || status === "disconnected") {
          this.maybeFallbackToMock();
        }
      });
      pulsescoreClient.connect();
    } else {
      this.maybeFallbackToMock();
    }
  }

  private maybeFallbackToMock() {
    if (this.usingMock || !env.SPORTS_DATA_MOCK_FALLBACK) return;
    this.usingMock = true;
    logger.info("Sports: a usar feed simulado (Pulsescore indisponível ou sem chave de API)");
    mockSportsFeed.on("update", (evt) => this.ingest(evt));
    for (const evt of mockSportsFeed.snapshot()) this.ingest(evt);
    mockSportsFeed.start();
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
