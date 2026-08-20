import { Router } from "express";
import { asyncHandler } from "../../middleware/errorHandler";
import { hybridSportsService } from "./hybridService";
import { getPrematchEvents } from "./prematch/service";
import { getTodayCompetitions } from "./competitions/service";
import { fetchEventById } from "./pulsescore/client";
import { getHeadToHead, getPredictions, getStandings, type HeadToHeadMatch } from "./apifootball/client";
import { resolveFixtureForEvent, resolveLeagueForEvent, resolveTeamsForEvent } from "./mapping/service";
import { ALL_SPORTS, type Sport } from "./types";
import { Errors } from "../../lib/errors";

const router = Router();

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
    const result = await getPrematchEvents(sport as Sport);
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
    const event = await fetchEventById(sport as Sport, rawId);
    if (!event) throw Errors.notFound("Evento não encontrado na Pulsescore");
    res.json({ event });
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
    const event = hybridSportsService.getById(req.params.id);
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
    const event = hybridSportsService.getById(req.params.id);
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
    const event = hybridSportsService.getById(req.params.id);
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
