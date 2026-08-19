import { Router } from "express";
import { asyncHandler } from "../../middleware/errorHandler";
import { hybridSportsService } from "./hybridService";
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
  "/events/:id/stats",
  asyncHandler(async (req, res) => {
    const stats = await hybridSportsService.getStatistics(req.params.id);
    if (!stats) throw Errors.notFound("Estatísticas indisponíveis para este evento");
    res.json(stats);
  })
);

export default router;
