import { EventEmitter } from "events";
import { env } from "../../config/env";
import { logger } from "../../lib/logger";
import { fetchLiveEvents, fetchLiveSportsWithEvents } from "./pulsescore/client";
import { mockSportsFeed } from "./mockFeed";
import { getFixtureStatistics } from "./apifootball/client";
import type { LiveEvent, Sport } from "./types";

const POLL_INTERVAL_MS = 25_000;

/**
 * Sistema híbrido: Pulsescore fornece odds/resultados (REST, com polling — ver
 * pulsescore/client.ts para o porquê de não ser websocket) para futebol, ténis, basquete,
 * hóquei de gelo, beisebol, voleibol, Fórmula 1 e MMA; API-Football enriquece com
 * estatísticas detalhadas sob pedido (só futebol). Mantém um snapshot em memória e reemite
 * atualizações para quem estiver subscrito (o gateway websocket interno consome estes eventos).
 *
 * Cada ciclo de polling chama primeiro GET /live-events/sports (leve, devolve só a lista de
 * desportos com pelo menos um evento ao vivo agora) e só depois pede GET /live-events?sport=
 * para esses desportos — evita gastar um pedido em cada um dos 8 às cegas quando a maioria
 * pode não ter nada ao vivo num dado momento. Pré-jogo (`live:false`) é um endpoint totalmente
 * separado (ver prematch/service.ts), não passa por aqui.
 * Se a Pulsescore não devolver nada ao vivo (chave não configurada, provedor em baixo, ou
 * simplesmente sem jogos ao vivo agora), cai automaticamente para o feed simulado.
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
    const seenIds = new Set<string>();

    try {
      const liveSports = await fetchLiveSportsWithEvents();
      for (const sport of liveSports) {
        try {
          const events = await fetchLiveEvents(sport, { maxPages: 2 });
          if (events.length) anyLive = true;
          for (const evt of events) {
            seenIds.add(evt.id);
            this.ingest(evt);
          }
        } catch (err) {
          logger.warn({ err, sport }, "Pulsescore: falha ao obter eventos ao vivo para este desporto");
        }
      }
    } catch (err) {
      logger.warn({ err }, "Pulsescore: falha ao obter live-events/sports");
    }

    if (anyLive) {
      this.disableMock();
      // Remove eventos reais que já não vieram neste ciclo (jogo terminou, deixou de estar ao vivo).
      for (const [id, evt] of this.events) {
        if (evt.source === "pulsescore" && !seenIds.has(id)) this.events.delete(id);
      }
    } else {
      this.enableMock();
    }
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
