import { logger } from "../../../lib/logger";
import { hybridSportsService } from "../hybridService";
import type { LiveEvent, LiveOdds } from "../types";
import { fetchFixturesBetween, fetchLivescoresInplay, normalizeLiveFixture } from "./client";

/**
 * Poller de Ao Vivo de futebol via Sportmonks (só ativo com FOOTBALL_PROVIDER=sportmonks, ver
 * server.ts) — substitui a Pulsescore/WebSocket para "football" nesse modo (ver hybridService.ts
 * e wsClient.ts, que passam a ignorar futebol quando o interruptor está ligado, para as duas
 * fontes não ficarem a substituir o snapshot uma da outra).
 *
 * Usa GET /livescores/inplay (fetchLivescoresInplay, ver client.ts) para placar/relógio — CONFIRMADO
 * por uma amostra real completa, sempre pedido de novo a cada ciclo (nunca em cache, ver
 * POLL_INTERVAL_MS). Para as odds, em vez de usar a cache partilhada do pré-jogo (janela de 5
 * dias, só atualizada a cada 40s — reportado pelo utilizador como "as odds não estão a
 * atualizar"), mantém a sua PRÓPRIA cache, só de hoje (janela muito mais pequena, poucas páginas)
 * e com um TTL bem mais curto (ver LIVE_ODDS_TTL_MS) — as odds ao vivo ficam assim independentes
 * da cadência do pré-jogo. Sem correspondência (jogo ainda não visto nesta cache, ou fora da
 * janela), o jogo aparece com placar/relógio mas sem mercados, em vez de ficar escondido — nunca
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
// fetchFixturesBetween() (usado aqui para as odds e em sportmonks/prematch.ts para o pré-jogo) —
// todos partilham a mesma quota horária. Ver LIVE_ODDS_TTL_MS abaixo para a conta do total.
const POLL_INTERVAL_MS = 5_000;

// Cache própria de odds ao vivo — só o dia de hoje (não os 5 dias do pré-jogo), por isso poucas
// páginas normalmente. TTL de 15s: a 3-4 pedidos/minuto (~180-240/hora) para esta cache, mais
// ~720/hora de /livescores/inplay (a cada 5s) e o pior caso do pré-jogo (~720/hora, a 40s/8
// páginas), fica-se por ~1680/hora — folgado face ao limite documentado de 3000/hora por
// entidade, mesmo sem confiar na quota maior vista na conta real (ver comentário em
// POLL_INTERVAL_MS acima).
const LIVE_ODDS_TTL_MS = 15_000;
let liveOddsCache: { byFixtureId: Map<number, LiveOdds[]>; fetchedAt: number } | null = null;

async function getLiveOddsByFixtureId(): Promise<Map<number, LiveOdds[]>> {
  if (liveOddsCache && Date.now() - liveOddsCache.fetchedAt < LIVE_ODDS_TTL_MS) return liveOddsCache.byFixtureId;
  const today = new Date().toISOString().slice(0, 10);
  const events = await fetchFixturesBetween(today, today, { maxPages: 3 });
  const byFixtureId = new Map<number, LiveOdds[]>();
  for (const e of events) {
    const id = Number(e.id.slice("sportmonks:".length));
    if (Number.isFinite(id)) byFixtureId.set(id, e.odds);
  }
  liveOddsCache = { byFixtureId, fetchedAt: Date.now() };
  return byFixtureId;
}

async function pollOnce() {
  try {
    const [fixtures, oddsByFixtureId] = await Promise.all([fetchLivescoresInplay(), getLiveOddsByFixtureId()]);
    const events: LiveEvent[] = [];
    for (const fixture of fixtures) {
      const evt = normalizeLiveFixture(fixture, oddsByFixtureId.get(fixture.id) ?? []);
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
