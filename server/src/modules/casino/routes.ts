import { Router } from "express";
import { env } from "../../config/env";
import { Errors } from "../../lib/errors";
import { asyncHandler } from "../../middleware/errorHandler";
import { requireAuth, type AuthedRequest } from "../../middleware/auth";
import { listGames, listHighlightedGames } from "./catalog";
import { getGameImage } from "./imageProxy";
import {
  handleWinCallback,
  handleCancelCallback,
  handleStatusCallback,
  toCallbackErrorResponse,
  requestGameLaunch,
  type CasinoCallbackData,
} from "./service";

const router = Router();

router.get(
  "/games",
  asyncHandler(async (req, res) => {
    const search = typeof req.query.search === "string" ? req.query.search : undefined;
    const category = typeof req.query.category === "string" ? req.query.category : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const offset = req.query.offset ? Number(req.query.offset) : undefined;
    res.json(listGames({ search, category, limit, offset }));
  })
);

router.get(
  "/games/highlighted",
  asyncHandler(async (_req, res) => {
    res.json({ games: listHighlightedGames() });
  })
);

// Proxy de imagens: tenta buscar a imagem real do provedor no servidor (em vez do browser do
// jogador ir buscar diretamente a api.playxspin.com, que confirmámos dar timeout de ligação —
// provavelmente falta de whitelist de IP do lado do provedor). Sem imagem real, devolve sempre
// um placeholder gerado, nunca um 404 — o cartão do jogo nunca fica com ícone de imagem partida.
router.get(
  "/image/:gameCode",
  asyncHandler(async (req, res) => {
    const image = await getGameImage(req.params.gameCode);
    if (!image) return res.status(404).end();
    res.setHeader("Cache-Control", image.isPlaceholder ? "public, max-age=120" : "public, max-age=21600");
    res.setHeader("Content-Type", image.contentType);
    res.send(image.buffer);
  })
);

router.post(
  "/launch",
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const gameCode = typeof req.body?.game_code === "string" ? req.body.game_code : undefined;
    if (!gameCode) throw Errors.badRequest("game_code em falta");
    const result = await requestGameLaunch(gameCode);
    res.json(result);
  })
);

// Callbacks do provedor (Win/Cancel/Status) — verificação do header "Callback-Token" contra
// CASINO_CALLBACK_TOKEN, conforme o contrato. Sem CASINO_CALLBACK_TOKEN configurado, os
// callbacks são recusados (nunca aceites "por omissão" sem segredo nenhum).
function verifyCallbackToken(req: { headers: Record<string, unknown> }) {
  const header = req.headers["callback-token"];
  const token = Array.isArray(header) ? header[0] : header;
  if (!env.CASINO_CALLBACK_TOKEN || token !== env.CASINO_CALLBACK_TOKEN) {
    throw Errors.unauthorized("Callback-Token inválido ou em falta");
  }
}

router.post(
  "/callback/win",
  asyncHandler(async (req, res) => {
    try {
      verifyCallbackToken(req);
      const data = req.body?.data as CasinoCallbackData;
      const result = await handleWinCallback(data);
      res.json(result);
    } catch (err) {
      res.json(toCallbackErrorResponse(err));
    }
  })
);

router.post(
  "/callback/cancel",
  asyncHandler(async (req, res) => {
    try {
      verifyCallbackToken(req);
      const data = req.body?.data as CasinoCallbackData;
      const result = await handleCancelCallback(data);
      res.json(result);
    } catch (err) {
      res.json(toCallbackErrorResponse(err));
    }
  })
);

router.post(
  "/callback/status",
  asyncHandler(async (req, res) => {
    try {
      verifyCallbackToken(req);
      const data = req.body?.data as { account: string; trans_guid: string };
      const result = await handleStatusCallback(data.account, data.trans_guid);
      res.json(result);
    } catch (err) {
      res.json(toCallbackErrorResponse(err));
    }
  })
);

export default router;
