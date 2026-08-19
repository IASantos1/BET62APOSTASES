import { Router } from "express";
import { asyncHandler } from "../../middleware/errorHandler";
import { hybridSportsService } from "./hybridService";
import { getPrematchEvents } from "./prematch/service";
import { fetchEventById } from "./pulsescore/client";
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

export default router;
