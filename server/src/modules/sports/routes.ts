import { Router } from "express";
import { asyncHandler } from "../../middleware/errorHandler";
import { hybridSportsService } from "./hybridService";
import { getPrematchEvents } from "./prematch/service";
import { getTodayCompetitions } from "./competitions/service";
import { fetchEventById, fetchLiveEventById } from "./pulsescore/client";
import { getHeadToHead, getPredictions, getStandings, getFixtureStatistics, type HeadToHeadMatch } from "./apifootball/client";
import { resolveFixtureForEvent, resolveLeagueForEvent, resolveTeamsForEvent, getFullFixtureMapping } from "./mapping/service";
import { getUnifiedMatchData } from "./unified/service";
import { sanitizePublicEvent, sanitizePublicEvents } from "./publicEvent";
import { getSportmonksEventById, getSportmonksFootballPrematchDiagnosis } from "./sportmonks/prematch";
import {
  diagnoseLiveOddsMovement,
  fetchBallCoordinates,
  fetchFixtureDetail,
  fetchInplayOddsForFixture,
  fetchTodayRawFixtureForLiveDiagnosis,
  getHeadToHeadForFixture,
  getMatchTimeline,
  getPlayerCachedPhoto,
  getStandingsBySeason,
  getTeamCachedLogo,
  getTeamFormForFixture,
  getTopscorersBySeason,
  importAllPlayers,
  importAllTeams,
  normalizeFixtureDetail,
  normalizeBallPositions,
  normalizeStandingsRow,
  normalizeTopscorerEntry,
  resolveRoundAndSeasonId,
} from "./sportmonks/client";
import { ALL_SPORTS, type LiveEvent, type Sport } from "./types";
import { getPricedFeaturedCombosForEvent } from "../featuredCombos/service";
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

// Diagnóstico temporário — pedido explícito do utilizador ("odds em ao vivo não está funcionando",
// mesmo depois da cache de 15s e do refresh on-demand ao abrir o jogo). Pede as odds do mesmo jogo
// ao vivo duas vezes com um intervalo (por omissão 8s) e diz se os valores mudaram — responde de
// vez se a Sportmonks está mesmo a atualizar odds ao vivo através deste endpoint, ou se o
// problema está noutro sítio. `?waitMs=15000` para um intervalo maior.
router.get(
  "/sportmonks-odds-movement-debug",
  asyncHandler(async (req, res) => {
    const waitMs = typeof req.query.waitMs === "string" && Number.isFinite(Number(req.query.waitMs)) ? Number(req.query.waitMs) : undefined;
    try {
      const result = await diagnoseLiveOddsMovement(waitMs);
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
    // Só "live" — este é o endpoint "Ao Vivo" (getLiveEvents no frontend, api.js). O
    // hybridSportsService também guarda jogos "scheduled" (Sportmonks: syncScheduledToHybrid em
    // sportmonks/prematch.ts injeta-os no mesmo mapa "football" de propósito, para getById()
    // conseguir encontrar jogos de pré-jogo pelo id; Pulsescore: wsClient.ts também pode marcar
    // "scheduled" um evento dentro de um snapshot "live"). Sem este filtro, jogos por começar
    // apareciam na lista "Ao Vivo" — bug real reportado pelo utilizador.
    res.json({ events: sanitizePublicEvents(hybridSportsService.snapshot(sport).filter((e) => e.status === "live")) });
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
    res.json({ ...result, events: sanitizePublicEvents(result.events) });
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
    // Jogos da Sportmonks (só futebol, FOOTBALL_PROVIDER=sportmonks) têm o seu próprio refresh —
    // pedido explícito do utilizador ("as odds em ao vivo não estão atualizando"): ao abrir o
    // Match Tracker, busca-se esse jogo sozinho, em vez de cair nos fetchers da Pulsescore abaixo
    // (que não reconhecem este formato de id). Sem mapeamento API-Football nem enriquecimento
    // cross-bookmaker aqui — esses são conceitos só da Pulsescore.
    if (req.params.id.startsWith("sportmonks:")) {
      const fixtureId = Number(req.params.id.slice("sportmonks:".length));
      if (!Number.isFinite(fixtureId)) throw Errors.badRequest("Id de evento Sportmonks inválido");
      const detail = await fetchFixtureDetail(fixtureId);
      let event = normalizeFixtureDetail(detail);
      if (!event) throw Errors.notFound("Evento não encontrado na Sportmonks");
      // As odds de fetchFixtureDetail (GET /fixtures/{id}) confirmaram-se congeladas desde antes
      // do apito inicial (ver diagnoseLiveOddsMovement em sportmonks/client.ts) — para um jogo já
      // a decorrer, troca-se pelas odds do endpoint de Ao Vivo confirmado (/odds/inplay/fixtures/
      // {id}), que sim atualiza durante o jogo. Falha aqui não esconde o jogo — fica só com as
      // odds congeladas em vez de nada.
      if (event.status === "live") {
        try {
          const liveOdds = await fetchInplayOddsForFixture(fixtureId);
          if (liveOdds.length) event = { ...event, odds: liveOdds };
        } catch (err) {
          logger.warn({ err: String(err).slice(0, 200), fixtureId }, "Sportmonks: falha ao obter odds ao vivo (inplay) no refresh on-demand");
        }
      }
      res.json({ event: sanitizePublicEvent(event) });
      return;
    }

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
    // O preenchimento de mercados/estatísticas em falta via OUTRAS bookmakers (cross-bookmaker
    // fallback) foi removido na reescrita da integração Pulsescore/Sportmonks (2026-08-27): só
    // fazia sentido com várias bookmakers configuradas em paralelo (ver histórico em
    // docs/SPORTS_DATA.md) — agora há só uma (env.PULSESCORE_BOOKMAKER, "onexbet"), por isso não
    // há para onde "cair" nenhum fallback. `completed` é o próprio evento tal como veio.
    const completed = event;

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

    res.json({ event: sanitizePublicEvent(completed) });
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
    // ⚠️ CORREÇÃO (2026-08-26): híbrido tenta primeiro hybridSportsService.getStatistics() —
    // que consulta o Map de eventos AO VIVO e resolve o fixture AF mapeado. Para scheduled,
    // o Map pode ainda não ter o evento (antes do sync do prematch, ou Sportmonks), por isso
    // adiciona fallback: findCachedEvent (procura também no cache de pré-jogo Sportmonks) +
    // resolveFixtureForEvent (lazy mapping) + getFixtureStatistics diretamente via API-Football.
    let stats = await hybridSportsService.getStatistics(req.params.id).catch(() => null);
    if (!stats) {
      const event = findCachedEvent(req.params.id);
      if (event && event.sport === "football") {
        const resolved = await resolveFixtureForEvent(event).catch(() => null);
        if (resolved) stats = await getFixtureStatistics(resolved.fixtureId).catch(() => null);
      }
    }
    if (!stats) throw Errors.notFound("Estatísticas indisponíveis para este evento");
    res.json(stats);
  })
);

// Confrontos diretos (H2H) — jogos da Sportmonks usam o endpoint NATIVO (GET /fixtures/head-to-
// head/{team1}/{team2}, ver sportmonks/client.ts), sem depender do motor de mapeamento por nome.
// Os restantes (Pulsescore) continuam na API-Football, resolvendo as duas equipas através do
// motor de mapeamento persistente (mapping/service.ts::resolveTeamsForEvent, ver
// docs/TEAM_MAPPING.md), não por pesquisa de nome direta a cada pedido.
router.get(
  "/events/:id/h2h",
  asyncHandler(async (req, res) => {
    const event = findCachedEvent(req.params.id);
    if (!event) throw Errors.notFound("Evento não encontrado");

    if (req.params.id.startsWith("sportmonks:")) {
      const fixtureId = Number(req.params.id.slice("sportmonks:".length));
      const matches = Number.isFinite(fixtureId) ? await getHeadToHeadForFixture(fixtureId).catch(() => []) : [];
      return res.json({ matches });
    }

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

// Classificação da liga do evento — só futebol. Jogos da Sportmonks (id "sportmonks:...") usam a
// classificação NATIVA da Sportmonks (GET /standings/seasons/{seasonId}, ver sportmonks/client.ts)
// — mais rica (inclui Expected Points/xPTS, forma recente e zona de qualificação/despromoção) e
// sem depender do motor de mapeamento por nome; usa a época inteira (não a ronda do jogo em
// concreto) para mostrar sempre a tabela mais atual, mesmo ao abrir um jogo já terminado há
// semanas. Os restantes (Pulsescore) continuam a usar a API-Football, resolvendo a liga pelo motor
// de mapeamento (mapping/service.ts::resolveLeagueForEvent) em vez de pesquisar o nome a cada
// pedido.
router.get(
  "/events/:id/standings",
  asyncHandler(async (req, res) => {
    const event = findCachedEvent(req.params.id);
    if (!event) throw Errors.notFound("Evento não encontrado");
    if (event.sport !== "football") return res.json({ standings: [] });

    if (req.params.id.startsWith("sportmonks:")) {
      const fixtureId = Number(req.params.id.slice("sportmonks:".length));
      const ids = Number.isFinite(fixtureId) ? await resolveRoundAndSeasonId(fixtureId).catch(() => null) : null;
      if (!ids) return res.json({ standings: [] });
      const rows = await getStandingsBySeason(ids.seasonId);
      return res.json({ standings: rows.map(normalizeStandingsRow) });
    }

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

// Artilheiros da época — só futebol, só jogos da Sportmonks (GET /topscorers/seasons/{seasonId},
// ver sportmonks/client.ts). Sem equivalente ligado nesta app para a API-Football, por isso jogos
// da Pulsescore devolvem sempre lista vazia (nunca um erro) — mesma disciplina "nunca inventa
// dados" já usada nas outras rotas derivadas acima.
router.get(
  "/events/:id/topscorers",
  asyncHandler(async (req, res) => {
    const event = findCachedEvent(req.params.id);
    if (!event) throw Errors.notFound("Evento não encontrado");
    if (event.sport !== "football" || !req.params.id.startsWith("sportmonks:")) return res.json({ topscorers: [] });

    const fixtureId = Number(req.params.id.slice("sportmonks:".length));
    const ids = Number.isFinite(fixtureId) ? await resolveRoundAndSeasonId(fixtureId).catch(() => null) : null;
    if (!ids) return res.json({ topscorers: [] });

    const entries = await getTopscorersBySeason(ids.seasonId);
    res.json({ topscorers: entries.map(normalizeTopscorerEntry) });
  })
);

// Forma recente/próximos jogos das duas equipas — só futebol, só jogos da Sportmonks (GET
// /schedules/teams/{teamId}, ver sportmonks/client.ts). Jogos da Pulsescore devolvem home/away
// null, nunca um erro — mesma disciplina "nunca inventa dados" das rotas acima.
router.get(
  "/events/:id/form",
  asyncHandler(async (req, res) => {
    const event = findCachedEvent(req.params.id);
    if (!event) throw Errors.notFound("Evento não encontrado");
    if (event.sport !== "football" || !req.params.id.startsWith("sportmonks:")) return res.json({ home: null, away: null });

    const fixtureId = Number(req.params.id.slice("sportmonks:".length));
    if (!Number.isFinite(fixtureId)) return res.json({ home: null, away: null });

    const form = await getTeamFormForFixture(fixtureId).catch(() => ({ home: null, away: null }));
    res.json(form);
  })
);

// Linha do tempo do jogo (golos/cartões/substituições) — só futebol, só jogos da Sportmonks (GET
// /fixtures/{id} com events.player;events.type incluído, ver sportmonks/client.ts). Jogos da
// Pulsescore devolvem lista vazia, nunca um erro — mesma disciplina das rotas acima.
router.get(
  "/events/:id/timeline",
  asyncHandler(async (req, res) => {
    const event = findCachedEvent(req.params.id);
    if (!event) throw Errors.notFound("Evento não encontrado");
    if (event.sport !== "football" || !req.params.id.startsWith("sportmonks:")) return res.json({ events: [] });

    const fixtureId = Number(req.params.id.slice("sportmonks:".length));
    if (!Number.isFinite(fixtureId)) return res.json({ events: [] });

    const detail = await fetchFixtureDetail(fixtureId).catch(() => null);
    res.json({ events: detail ? getMatchTimeline(detail) : [] });
  })
);

// Posição da bola no campo (mini campo 2D do Match Tracker) — só futebol, só jogos da Sportmonks
// e só ligas com esta tecnologia de tracking (GET /fixtures/{id}?include=ballCoordinates, ver
// fetchBallCoordinates em sportmonks/client.ts). Sem esta cobertura, devolve lista vazia, nunca um
// erro — mesma disciplina "nunca inventa dados" das rotas acima.
router.get(
  "/events/:id/ball-position",
  asyncHandler(async (req, res) => {
    const event = findCachedEvent(req.params.id);
    if (!event) throw Errors.notFound("Evento não encontrado");
    if (event.sport !== "football" || !req.params.id.startsWith("sportmonks:")) return res.json({ points: [] });

    const fixtureId = Number(req.params.id.slice("sportmonks:".length));
    if (!Number.isFinite(fixtureId)) return res.json({ points: [] });

    const coordinates = await fetchBallCoordinates(fixtureId).catch(() => []);
    res.json({ points: normalizeBallPositions(coordinates) });
  })
);

// Logos de equipa Sportmonks — 302 transparente para o CDN deles (cdn.sportmonks.com).
// Motivo: há setups (Cloudflare, CSPs, etc.) onde o browser não carrega direto imagens de CDNs
// terceiros ou bloqueia por política de referrer; este endpoint funciona como fallback. Também
// serve de atalho só por ID (url amigável, tipo /teams/logo/53) sem ter de carregar o image_path
// de cada resposta. 404 se o ID não for conhecido no cache local de teams.
router.get("/teams/logo/:id", (req, res) => {
  const rawId = Number(req.params.id);
  if (!Number.isFinite(rawId)) return res.status(400).end();
  const url = getTeamCachedLogo(rawId);
  if (!url) return res.status(404).end();
  res.redirect(302, url);
});

// Fotos de jogadores Sportmonks — mesma filosofia do endpoint /teams/logo acima. 302 transparente
// para o CDN deles; 404 se o jogador não for conhecido no cache local (ainda não foi feito o
// /import-players, ou a Sportmonks não tem foto desse jogador — image_path = placeholder).
router.get("/players/photo/:id", (req, res) => {
  const rawId = Number(req.params.id);
  if (!Number.isFinite(rawId)) return res.status(400).end();
  const url = getPlayerCachedPhoto(rawId);
  if (!url) return res.status(404).end();
  res.redirect(302, url);
});

// Import one-shot de todos os teams (Get All Teams da Sportmonks) para preencher o cache de
// logos (getTeamCachedLogo). Uma vez corrido, todos os eventos que venham com participants SEM
// image_path (alguns endpoints omitiam este campo no passado) já têm backfill automático para o
// cache. Chamada admin-on-demand (não é chamada no startup normal do servidor — 25.000 equipas
// = 500 pedidos, fazê-lo no boot podia partir rate limits).
router.get(
  "/sportmonks-debug/import-teams",
  asyncHandler(async (_req, res) => {
    if (!process.env.SPORTMONKS_API_KEY) return res.json({ ok: false, message: "SPORTMONKS_API_KEY não configurada" });
    const r = await importAllTeams();
    res.json({ ok: r.errors === 0, loaded: r.total, errors: r.errors });
  })
);

// Import one-shot de todos os jogadores (Get All Players da Sportmonks). Preenche o cache de
// fotos (getPlayerCachedPhoto) que a timeline usa para jogadores em golos/cartões/substituições
// e a lista de artilheiros. Chamada admin-on-demand por ser um import pesado: ~250.000 jogadores
// em planos completos = 5000 páginas × 50 = 5000 pedidos. Para planos Starter (5 ligas) é bem
// menor.
router.get(
  "/sportmonks-debug/import-players",
  asyncHandler(async (_req, res) => {
    if (!process.env.SPORTMONKS_API_KEY) return res.json({ ok: false, message: "SPORTMONKS_API_KEY não configurada" });
    const r = await importAllPlayers();
    res.json({ ok: r.errors === 0, loaded: r.total, errors: r.errors });
  })
);

// "Melhores Escolhas" (combinações curadas por um admin, ver featuredCombos/service.ts) —
// qualquer desporto/fonte (não só futebol/Sportmonks, ao contrário das rotas acima), preços
// recalculados a partir das odds reais e atuais a cada pedido, nunca cacheados.
router.get(
  "/events/:id/featured-combos",
  asyncHandler(async (req, res) => {
    res.json({ combos: await getPricedFeaturedCombosForEvent(req.params.id) });
  })
);

export default router;
