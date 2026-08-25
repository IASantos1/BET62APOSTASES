import { Router } from "express";
import { asyncHandler } from "../../middleware/errorHandler";
import { hybridSportsService } from "./hybridService";
import { getPrematchEvents } from "./prematch/service";
import { getTodayCompetitions } from "./competitions/service";
import { fetchEventById, fetchLiveEventById } from "./pulsescore/client";
import { enrichEventFromOtherBookmakers } from "./pulsescore/crossBookmakerFallback";
import { getHeadToHead, getPredictions, getStandings, type HeadToHeadMatch } from "./apifootball/client";
import { resolveFixtureForEvent, resolveLeagueForEvent, resolveTeamsForEvent, getFullFixtureMapping } from "./mapping/service";
import { getUnifiedMatchData } from "./unified/service";
import { getSportmonksEventById, getSportmonksFootballPrematchDiagnosis } from "./sportmonks/prematch";
import { fetchTodayRawFixtureForLiveDiagnosis } from "./sportmonks/client";
import { ALL_SPORTS, type LiveEvent, type Sport } from "./types";
import { Errors } from "../../lib/errors";
import { logger } from "../../lib/logger";

const router = Router();

/** Procura um evento primeiro na cache ao vivo (hybridSportsService), depois — se for um id da
 * Sportmonks — na cache de pré-jogo da Sportmonks (getSportmonksEventById, sem pedido novo à
 * rede). Usado pelas rotas de H2H/previsões/classificação/mapeamento/auditoria de odds, que só
 * sabiam procurar na cache ao vivo e por isso devolviam sempre "não encontrado" para jogos de
 * pré-jogo da Sportmonks (reportado pelo utilizador como "estatísticas não aparecem"). Eventos de
 * pré-jogo da Pulsescore continuam sem este fallback aqui — limitação já existente antes da
 * Sportmonks, fora do âmbito deste pedido. */
function findCachedEvent(id: string): LiveEvent | null {
  return hybridSportsService.getById(id) ?? (id.startsWith("sportmonks:") ? getSportmonksEventById(id) : null);
}

// Diagnóstico temporário — sem autenticação de propósito, para se poder abrir diretamente no
// browser e colar aqui a resposta (texto simples, sem os problemas de copiar do painel /admin
// relatados nesta conversa). Não expõe nada sensível: só contagens e uma frase em português a
// dizer onde o funil ligas -> ronda atual -> jogos agendados está a ficar a zero.
router.get(
  "/sportmonks-debug",
  asyncHandler(async (_req, res) => {
    try {
      const result = await getSportmonksFootballPrematchDiagnosis();
      res.json({ ok: true, ...result });
    } catch (err) {
      res.json({ ok: false, message: err instanceof Error ? err.message : "Erro desconhecido" });
    }
  })
);

// Diagnóstico temporário (mesmo padrão do /sportmonks-debug acima) — para confirmar a forma real
// de uma fixture da Sportmonks já a decorrer (state_id, se há placar ao vivo, se as odds
// continuam presentes) antes de tentar migrar o Ao Vivo de futebol para a Sportmonks (pedido
// explícito do utilizador). Ver aviso "não confirmado" em sportmonks/client.ts.
router.get(
  "/sportmonks-live-debug",
  asyncHandler(async (_req, res) => {
    try {
      const result = await fetchTodayRawFixtureForLiveDiagnosis();
      res.json({ ok: true, ...result });
    } catch (err) {
      res.json({ ok: false, message: err instanceof Error ? err.message : "Erro desconhecido" });
    }
  })
);

router.get(
  "/events",
  asyncHandler(async (req, res) => {
    const sport = typeof req.query.sport === "string" ? (req.query.sport as any) : undefined;
    res.json({ events: hybridSportsService.snapshot(sport) });
  })
);

router.get(
  "/prematch",
  asyncHandler(async (req, res) => {
    const sport = req.query.sport;
    if (typeof sport !== "string" || !ALL_SPORTS.includes(sport as Sport)) {
      throw Errors.badRequest("Parâmetro sport em falta ou inválido");
    }
    const date = typeof req.query.date === "string" ? req.query.date : undefined;
    const result = await getPrematchEvents(sport as Sport, date);
    res.json(result);
  })
);

router.get(
  "/competitions",
  asyncHandler(async (_req, res) => {
    const competitions = await getTodayCompetitions();
    res.json({ competitions });
  })
);

router.get(
  "/events/:id/refresh",
  asyncHandler(async (req, res) => {
    const sport = req.query.sport;
    if (typeof sport !== "string" || !ALL_SPORTS.includes(sport as Sport)) {
      throw Errors.badRequest("Parâmetro sport em falta ou inválido");
    }
    const rawId = req.params.id.startsWith("pulsescore:") ? req.params.id.slice("pulsescore:".length) : req.params.id;

    // O evento pode ser: (a) pré-jogo / scheduled → endpoint desporto-específico
    // `/{bookmaker}/{sport}/events/{id}` OU (b) ao vivo → endpoint genérico
    // `/{bookmaker}/live-events/events/{id}` (sem sport no path, confirmado via doc oficial).
    // Tentamos os dois em cascata — se um throw/falhar, não matamos o pedido todo, só passamos
    // para o próximo. O 500 anterior vinha de eventos ao vivo a bater só no endpoint pré-jogo,
    // que devolvia != 404 (ex: 400 / 401) → throw Errors.internal.
    let event: LiveEvent | null = null;
    try {
      event = await fetchEventById(sport as Sport, rawId);
    } catch (err) {
      logger.warn({ err: String(err).slice(0, 200), sport, eventId: rawId, source: "sport-events" }, "Sports refresh: fetchEventById (pré-jogo) falhou, a tentar live-events");
    }

    if (!event) {
      try {
        event = await fetchLiveEventById(rawId, sport as Sport);
      } catch (err) {
        logger.warn({ err: String(err).slice(0, 200), eventId: rawId, source: "live-events" }, "Sports refresh: fetchLiveEventById (ao vivo) falhou");
      }
    }

    if (!event) throw Errors.notFound("Evento não encontrado na Pulsescore");
    // Preenche mercados e estatísticas em falta (ex: Escanteios/Cartões/Marcador) indo buscá-los
    // a outras bookmakers configuradas em marketRouting.ts — só aqui, quando o utilizador abre o
    // Match Tracker de um evento em concreto, nunca durante o polling em massa (ver
    // docs/SPORTS_DATA.md). Uma falha aqui nunca esconde o evento já obtido — o pior caso é
    // devolvê-lo sem o preenchimento extra, exatamente como antes desta funcionalidade existir.
    const completed = await enrichEventFromOtherBookmakers(sport as Sport, event).catch((err) => {
      logger.warn({ err, eventId: rawId }, "Pulsescore: falha ao preencher mercados/estatísticas em falta via outras bookmakers");
      return event!;
    });

    // DISPARAR LAZY MAPPING API-Football em background: mesmo que o user nunca abra o /stats
    // nem o /matches/:id/live, o simples acto de abrir o Match Tracker já guarda permanentemente
    // os IDs de equipa/liga/fixture na Base de Dados, para que os próximos pedidos (H2H,
    // previsões, classificação, estatísticas) já encontrem tudo mapeado e NÃO VOLTEM a chamar
    // a API-Football para ID resolution (só para os dados finais de estatísticas/H2H/etc).
    // Ignorado completamente se falhar (não quebra o refresh do evento).
    if ((sport as Sport) === "football") {
      void resolveFixtureForEvent(completed).catch((err) => {
        logger.debug({ err, eventId: completed.id }, "Mapping AF lazy trigger: falhou — ignorado (não bloqueia refresh do evento)");
      });
    }

    res.json({ event: completed });
  })
);

/**
 * Auditoria cross-bookmaker: quantos mercados no evento foram fornecidos por cada casa de
 * apostas. Usado para debug do fallback e para o UI/admin confirmar que a união de mercados
 * está mesmo a funcionar (ex: "paddypower: 12, bet365: 4, pinnacle_ps3838: 2").
 *
 * Tenta primeiro o evento em cache do hybridService (rápido, se estiver ao vivo). Se não
 * encontrar, tenta refresh on-demand como no /refresh endpoint (cascata pré-jogo → live).
 */
router.get(
  "/events/:id/odds/coverage",
  asyncHandler(async (req, res) => {
    const sport = req.query.sport;
    if (typeof sport !== "string" || !ALL_SPORTS.includes(sport as Sport)) {
      throw Errors.badRequest("Parâmetro sport em falta ou inválido");
    }
    const rawId = req.params.id.startsWith("pulsescore:") ? req.params.id.slice("pulsescore:".length) : req.params.id;

    let event: LiveEvent | null = findCachedEvent(req.params.id);

    if (!event) {
      try {
        event = await fetchEventById(sport as Sport, rawId);
      } catch {
        try {
          event = await fetchLiveEventById(rawId, sport as Sport);
        } catch {
          event = null;
        }
      }
    }
    if (!event) throw Errors.notFound("Evento não encontrado");

    const marketsCount: Record<string, number> = {};
    const selectionsCount: Record<string, number> = {};
    for (const o of event.odds) {
      const b = o.sourceBookmaker ?? "unknown";
      marketsCount[b] = (marketsCount[b] ?? 0) + 1;
      for (const sel of Object.values(o.selections ?? {})) {
        const sb = sel.sourceBookmaker ?? b;
        selectionsCount[sb] = (selectionsCount[sb] ?? 0) + 1;
      }
    }

    res.json({
      eventId: event.id,
      totalMarkets: event.odds.length,
      marketsCount,
      selectionsCount,
    });
  })
);

/**
 * Debug do motor de mapeamento API-Football (admin) — devolve o estado atual da linha
 * FixtureMapping: home/away/league teamIds, fixtureId da AF, confiança, verificação manual,
 * e a flag CRÍTICA invertedHomeAway (true = as estatísticas da AF precisam de ser trocadas
 * casa↔fora para continuar alinhadas com a Pulsescore).
 *
 * Se o mapping ainda não tiver sido criado, dispara-o nesta mesma chamada (lazy) para
 * já ficar disponível nas próximas.
 */
router.get(
  "/events/:id/mapping",
  asyncHandler(async (req, res) => {
    const sport = req.query.sport;
    if (typeof sport !== "string" || !ALL_SPORTS.includes(sport as Sport)) {
      throw Errors.badRequest("Parâmetro sport em falta ou inválido");
    }
    const rawId = req.params.id.startsWith("pulsescore:") ? req.params.id.slice("pulsescore:".length) : req.params.id;

    let event: LiveEvent | null = findCachedEvent(req.params.id);
    if (!event) {
      try {
        event = await fetchEventById(sport as Sport, rawId);
      } catch {
        try {
          event = await fetchLiveEventById(rawId, sport as Sport);
        } catch {
          event = null;
        }
      }
    }
    if (!event) throw Errors.notFound("Evento não encontrado");

    const state = await getFullFixtureMapping(event);

    res.json({
      pulsescoreEventKey: event.id,
      sport: event.sport,
      home: event.home,
      away: event.away,
      league: event.league,
      startTime: event.startTime,
      mapping: state,
      willHaveStats:
        event.sport === "football" &&
        Boolean(state.apiFootballFixtureId) &&
        state.confidence >= 70,
      invertedHomeAway: state.invertedHomeAway, // true = stats AF precisam swap casa↔fora
    });
  })
);

// Endpoint unificado (docs/UNIFIED_MATCH_DATA.md) — placar/estado/relógio/cartões/cantos da
// Pulsescore (fonte principal) combinados com as estatísticas complementares da API-Football
// (posse, remates, faltas, passes...) num único objeto, com a fonte de cada campo explícita.
// Mesmo :id usado nos outros endpoints (o próprio LiveEvent.id já funciona como o "internal
// match id" da BET62 — ver nota em unified/types.ts).
router.get(
  "/matches/:id/live",
  asyncHandler(async (req, res) => {
    const data = await getUnifiedMatchData(req.params.id);
    if (!data) throw Errors.notFound("Partida não encontrada");
    res.json(data);
  })
);

router.get(
  "/events/:id/stats",
  asyncHandler(async (req, res) => {
    const stats = await hybridSportsService.getStatistics(req.params.id);
    if (!stats) throw Errors.notFound("Estatísticas indisponíveis para este evento");
    res.json(stats);
  })
);

// Confrontos diretos (H2H) via API-Football — resolve as duas equipas através do motor de
// mapeamento persistente (mapping/service.ts::resolveTeamsForEvent, ver docs/TEAM_MAPPING.md),
// não por pesquisa de nome direta a cada pedido.
router.get(
  "/events/:id/h2h",
  asyncHandler(async (req, res) => {
    const event = findCachedEvent(req.params.id);
    if (!event) throw Errors.notFound("Evento não encontrado");
    const teams = await resolveTeamsForEvent(event);
    if (!teams) return res.json({ matches: [] });
    const data = await getHeadToHead(teams.homeTeamId, teams.awayTeamId, { last: 5 });
    const matches: HeadToHeadMatch[] = data.response.map((f) => ({
      date: f.fixture.date,
      homeTeam: f.teams.home.name,
      awayTeam: f.teams.away.name,
      homeGoals: f.goals.home,
      awayGoals: f.goals.away,
      competition: f.league.name,
    }));
    res.json({ matches });
  })
);

// Previsão real da API-Football (percent home/draw/away + conselho) — só futebol. Resolve o
// fixture pelo motor de mapeamento (mapping/service.ts::resolveFixtureForEvent). Sem fixture
// encontrado -> predictions: null, para o frontend cair no cálculo pelas odds em vez de erro.
router.get(
  "/events/:id/predictions",
  asyncHandler(async (req, res) => {
    const event = findCachedEvent(req.params.id);
    if (!event) throw Errors.notFound("Evento não encontrado");
    if (event.sport !== "football") return res.json({ predictions: null });
    const resolved = await resolveFixtureForEvent(event);
    if (!resolved) return res.json({ predictions: null });
    const data = await getPredictions(resolved.fixtureId);
    const p = data.response[0]?.predictions;
    res.json({ predictions: p ? { winnerName: p.winner?.name ?? null, advice: p.advice, percent: p.percent } : null });
  })
);

// Classificação da liga do evento — só futebol. Resolve a liga pelo motor de mapeamento
// (mapping/service.ts::resolveLeagueForEvent) em vez de pesquisar o nome a cada pedido.
router.get(
  "/events/:id/standings",
  asyncHandler(async (req, res) => {
    const event = findCachedEvent(req.params.id);
    if (!event) throw Errors.notFound("Evento não encontrado");
    if (event.sport !== "football") return res.json({ standings: [] });
    const league = await resolveLeagueForEvent(event);
    if (!league) return res.json({ standings: [] });
    const data = await getStandings(league.leagueId, league.season);
    const table = data.response[0]?.league.standings[0] ?? [];
    res.json({
      standings: table.map((r) => ({
        rank: r.rank,
        team: r.team.name,
        points: r.points,
        played: r.all.played,
        win: r.all.win,
        draw: r.all.draw,
        lose: r.all.lose,
        goalsFor: r.all.goals.for,
        goalsAgainst: r.all.goals.against,
        goalsDiff: r.goalsDiff,
        form: r.form,
      })),
    });
  })
);

export default router;
