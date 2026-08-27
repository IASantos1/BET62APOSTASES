import { EventEmitter } from "events";
import { env } from "../../config/env";
import { logger } from "../../lib/logger";
import { fetchLiveEvents, fetchLiveSportsUnionAllBookmakers } from "./pulsescore/client";
import { pulsescoreWs } from "./pulsescore/wsClient";
import { getFixtureStatistics } from "./apifootball/client";
import { resolveFixtureForEvent } from "./mapping/service";
import { ALL_SPORTS, type LiveEvent, type Sport } from "./types";

const POLL_INTERVAL_MS = 25_000;
const TENNIS_POINT_RANK: Record<string, number> = { "0": 0, "15": 1, "30": 2, "40": 3, ad: 4, adv: 4, advantage: 4, a: 4 };

// Margem antes de tratar um evento "desaparecido de um snapshot" como mesmo terminado — a
// Pulsescore não confirma nenhum estado "interrompido"/"atrasado"/"cancelado" (ver
// betting/settlement.ts), por isso não há forma de distinguir com confiança um jogo que só
// terminou de um jogo temporariamente suspenso (chuva forte, emergência médica) que a Pulsescore
// pode deixar de reportar por instantes antes de voltar a incluir. Sem esta margem, um jogo
// suspenso desaparecia e liquidava (ou ia para revisão) no instante seguinte, mesmo continuando
// "ao vivo" na realidade — pedido explícito do utilizador ("mantendo ele sempre ao vivo pra
// quando ele voltar ao normal"). Bem acima do intervalo de sondagem REST (25s) e de várias
// frames do WebSocket, para não reagir a uma única falha pontual do feed.
const REMOVE_GRACE_MS = 90_000;

function tennisPointRank(value: LiveEvent["homeScore"] | LiveEvent["awayScore"]): number | null {
  if (value == null) return null;
  const normalized = String(value).trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(TENNIS_POINT_RANK, normalized) ? TENNIS_POINT_RANK[normalized] : null;
}

function sameNumericArrays(a: number[] | undefined, b: number[] | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((value, idx) => value === b[idx]);
}

function isSameTennisGameContext(previous: LiveEvent, incoming: LiveEvent): boolean {
  const prevSets = previous.statistics?.sets;
  const nextSets = incoming.statistics?.sets;
  return (
    previous.minuteOrPeriod === incoming.minuteOrPeriod &&
    sameNumericArrays(prevSets?.home, nextSets?.home) &&
    sameNumericArrays(prevSets?.away, nextSets?.away)
  );
}

function shouldKeepPreviousTennisPoints(previous: LiveEvent, incoming: LiveEvent): boolean {
  if (previous.sport !== "tennis" || incoming.sport !== "tennis") return false;
  if (previous.status !== "live" || incoming.status !== "live") return false;
  if (!isSameTennisGameContext(previous, incoming)) return false;
  if (previous.homeScore == null || previous.awayScore == null) return false;
  if (incoming.homeScore == null || incoming.awayScore == null) return true;

  const prevHome = tennisPointRank(previous.homeScore);
  const prevAway = tennisPointRank(previous.awayScore);
  const nextHome = tennisPointRank(incoming.homeScore);
  const nextAway = tennisPointRank(incoming.awayScore);
  if (prevHome == null || prevAway == null || nextHome == null || nextAway == null) return false;

  return nextHome + nextAway < prevHome + prevAway;
}

function mergeTransientTennisScore(previous: LiveEvent | undefined, incoming: LiveEvent): LiveEvent {
  if (!previous || !shouldKeepPreviousTennisPoints(previous, incoming)) return incoming;
  logger.info(
    {
      eventId: incoming.id,
      previousScore: `${previous.homeScore}-${previous.awayScore}`,
      incomingScore: `${incoming.homeScore ?? "?"}-${incoming.awayScore ?? "?"}`,
      set: incoming.minuteOrPeriod,
    },
    "Pulsescore: a manter último ponto válido do ténis no mesmo set"
  );
  return { ...incoming, homeScore: previous.homeScore, awayScore: previous.awayScore };
}

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
  // eventId -> primeira vez que reparámos que estava a faltar de um snapshot (ver REMOVE_GRACE_MS)
  private missingSince = new Map<string, number>();

  start() {
    if (!env.PULSESCORE_API_KEY) {
      logger.warn("Sports: PULSESCORE_API_KEY não configurada — feed Ao Vivo ficará sempre vazio");
      return;
    }
    pulsescoreWs.on("snapshot", ({ sport, events }: { sport: Sport; events: LiveEvent[] }) => {
      this.applySportSnapshot(sport, events);
    });
    void pulsescoreWs.start().catch((err) => {
      logger.warn({ err: String(err).slice(0, 200) }, "Pulsescore WS: falhou inicialização do líder (continuando só com REST/polling)");
    });

    this.pollOnce();
    setInterval(() => this.pollOnce(), POLL_INTERVAL_MS);
  }

  private async pollOnce() {
    const wsCovered = pulsescoreWs.activeSports();
    const live = new Set<Sport>();
    // Futebol Ao Vivo passa a ser dono exclusivo da Sportmonks quando o interruptor está ligado
    // (ver sportmonks/live.ts) — a Pulsescore (REST aqui e WebSocket em wsClient.ts) tem de parar
    // de tocar em "football" para as duas fontes não ficarem a substituir o snapshot uma da
    // outra a cada ciclo (25s Pulsescore vs. o intervalo do poller da Sportmonks).
    const sportmonksOwnsFootball = env.FOOTBALL_PROVIDER === "sportmonks";

    try {
      const liveSports = await fetchLiveSportsUnionAllBookmakers();
      for (const sport of liveSports) live.add(sport);

      const uncoveredSports = [...live].filter((sport) => {
        if (sportmonksOwnsFootball && sport === "football") return false;
        if (wsCovered.has(sport)) return false; // já coberto pelo WebSocket, REST duplicaria
        return true;
      });
      await Promise.all(
        uncoveredSports.map(async (sport) => {
          try {
            const events = await fetchLiveEvents(sport, { maxPages: 2 });
            this.applySportSnapshot(sport, events);
          } catch (err) {
            logger.warn({ err, sport }, "Pulsescore: falha ao obter eventos ao vivo para este desporto");
          }
        })
      );
    } catch (err) {
      logger.warn({ err }, "Pulsescore: falha ao obter live-events/sports");
    }

    // Desportos sem eventos ao vivo agora (nem via REST nem via WebSocket) ficam vazios.
    for (const sport of ALL_SPORTS) {
      if (sportmonksOwnsFootball && sport === "football") continue; // não apagar o snapshot da Sportmonks
      if (!live.has(sport) && !wsCovered.has(sport)) this.applySportSnapshot(sport, []);
    }
  }

  /** Substitui todos os eventos de um desporto de uma vez — usado tanto pelo polling REST
   * (um desporto por chamada) como por cada frame do WebSocket (todos os eventos ao vivo
   * desse desporto naquele instante). Um evento que desaparece de um snapshot só é removido a
   * sério depois de continuar ausente durante REMOVE_GRACE_MS (ver comentário na constante) —
   * antes disso fica tal como estava, ainda "ao vivo" com o último estado conhecido. Sem
   * qualquer margem, o gateway (ver websocket/gateway.ts) avisava o frontend e o motor de
   * liquidação disparava logo no próximo ciclo — bom para um jogo mesmo terminado, mas errado
   * para uma suspensão temporária que a Pulsescore pode deixar de reportar por instantes.
   */
  private applySportSnapshot(sport: Sport, events: LiveEvent[]) {
    const incomingIds = new Set(events.map((e) => e.id));
    const now = Date.now();
    for (const [id, evt] of this.events) {
      if (evt.sport !== sport || incomingIds.has(id)) continue;
      const missingSince = this.missingSince.get(id);
      if (missingSince === undefined) {
        this.missingSince.set(id, now); // primeira vez que falta — dá-lhe mais um ciclo antes de decidir
        continue;
      }
      if (now - missingSince < REMOVE_GRACE_MS) continue; // ainda dentro da margem, mantém como estava

      this.events.delete(id);
      this.missingSince.delete(id);
      // Segundo argumento (o último estado conhecido, com o placar final) adicionado para a
      // liquidação de apostas (betting/settlement.ts) — a Pulsescore nunca reporta um estado
      // "finished" explícito neste feed, o jogo simplesmente desaparece do próximo snapshot,
      // por isso este é o único momento em que o placar final ainda está disponível.
      // Aditivo: quem só ouvia `(id)` (ex: websocket/gateway.ts) continua a funcionar sem
      // alterações.
      this.emit("remove", id, evt);
    }
    for (const evt of events) {
      this.missingSince.delete(evt.id); // voltou a aparecer — já não está "a faltar"
      this.ingest(evt);
    }
  }

  private ingest(evt: LiveEvent) {
    const merged = mergeTransientTennisScore(this.events.get(evt.id), evt);
    this.events.set(merged.id, merged);
    this.emit("event", merged);
  }

  /** Ponto de entrada para fontes ao vivo externas ao par WS/REST da Pulsescore — usado pelo
   * poller de Ao Vivo da Sportmonks (só futebol, quando FOOTBALL_PROVIDER=sportmonks, ver
   * sportmonks/live.ts) para injetar o snapshot sem duplicar a lógica de remoção com margem já
   * feita em applySportSnapshot() (liquidação de apostas, WS gateway, etc. continuam a funcionar
   * exatamente da mesma forma, os eventos 'event'/'remove' não distinguem a fonte). */
  applyExternalSnapshot(sport: Sport, events: LiveEvent[]) {
    this.applySportSnapshot(sport, events);
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
