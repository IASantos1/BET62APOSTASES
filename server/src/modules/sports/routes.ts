import { Router } from "express";
import { asyncHandler } from "../../middleware/errorHandler";
import { hybridSportsService } from "./hybridService";
import { getPrematchEvents } from "./prematch/service";
import { getTodayCompetitions } from "./competitions/service";
import { fetchEventById } from "./pulsescore/client";
import { getHeadToHeadByTeamNames, resolveFixtureIdByTeamNames, getPredictions, getStandingsByLeagueName } from "./apifootball/client";
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

// Confrontos diretos (H2H) via API-Football, resolvendo as equipas por nome — ver
// getHeadToHeadByTeamNames() para as limitações (melhor esforço, sem mapeamento confirmado de
// id de equipa entre a Pulsescore e a API-Football).
router.get(
  "/events/:id/h2h",
  asyncHandler(async (req, res) => {
    const event = hybridSportsService.getById(req.params.id);
    if (!event) throw Errors.notFound("Evento não encontrado");
    const matches = await getHeadToHeadByTeamNames(event.home, event.away);
    res.json({ matches });
  })
);

// Previsão real da API-Football (percent home/draw/away + conselho) — só futebol. Resolve o
// fixture_id pelas equipas (melhor esforço, ver resolveFixtureIdByTeamNames). Sem fixture
// encontrado -> predictions: null, para o frontend cair no cálculo pelas odds em vez de erro.
router.get(
  "/events/:id/predictions",
  asyncHandler(async (req, res) => {
    const event = hybridSportsService.getById(req.params.id);
    if (!event) throw Errors.notFound("Evento não encontrado");
    if (event.sport !== "football") return res.json({ predictions: null });
    const fixtureId = await resolveFixtureIdByTeamNames(event.home, event.away, event.startTime?.slice(0, 10));
    if (!fixtureId) return res.json({ predictions: null });
    const data = await getPredictions(fixtureId);
    const p = data.response[0]?.predictions;
    res.json({ predictions: p ? { winnerName: p.winner?.name ?? null, advice: p.advice, percent: p.percent } : null });
  })
);

// Classificação da liga do evento — só futebol. Resolve a liga pelo nome (ver
// getStandingsByLeagueName), melhor esforço tal como o resto da integração API-Football.
router.get(
  "/events/:id/standings",
  asyncHandler(async (req, res) => {
    const event = hybridSportsService.getById(req.params.id);
    if (!event) throw Errors.notFound("Evento não encontrado");
    if (event.sport !== "football") return res.json({ standings: [] });
    const standings = await getStandingsByLeagueName(event.league);
    res.json({ standings });
  })
);

export default router;
