import { Router } from "express";
import { env } from "../../config/env";
import { Errors } from "../../lib/errors";
import { asyncHandler } from "../../middleware/errorHandler";
import { requireAuth, requireRole, type AuthedRequest } from "../../middleware/auth";
import { listGames, listHighlightedGames } from "./catalog";
import { getGameImage } from "./imageProxy";
import { getAgentInfo } from "./apiClient";
import {
  handleAuthenticateCallback,
  handleBalanceCallback,
  handleBetCallback,
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
    const gameUrl = await requestGameLaunch(req.user!.id, gameCode);
    res.json({ game_url: gameUrl });
  })
);

// Diagnóstico: devolve o `client_ip` (como o provedor vê o nosso IP de saída) e a `whitelist`
// configurada do lado deles — útil para confirmar se o IP da Railway já está autorizado, sem
// precisar de correr curls manuais na Console.
router.get(
  "/agent-info",
  requireAuth,
  requireRole("SUPPORT", "ADMIN"),
  asyncHandler(async (_req, res) => {
    res.json(await getAgentInfo());
  })
);

// Callback do provedor — UM único URL configurado no painel de agente, que envia todos os
// comandos (authenticate/balance/bet/win/cancel/status) para o mesmo sítio, distinguidos pelo
// campo `command` do corpo (confirmado pela doc real "Callback API Example" colada pelo
// utilizador — antes assumíamos, sem confirmação, 3 URLs distintas para win/cancel/status, o
// que causava "CALLBACK_ERROR" ao pedir o game-url, porque o teste de `authenticate` do
// provedor não tinha rota nenhuma para responder). Verificação do header "Callback-Token"
// contra CASINO_CALLBACK_TOKEN, conforme o contrato — sem isso configurado, os callbacks são
// sempre recusados (nunca aceites "por omissão" sem segredo nenhum).
function verifyCallbackToken(req: { headers: Record<string, unknown> }) {
  const header = req.headers["callback-token"];
  const token = Array.isArray(header) ? header[0] : header;
  if (!env.CASINO_CALLBACK_TOKEN || token !== env.CASINO_CALLBACK_TOKEN) {
    throw Errors.unauthorized("Callback-Token inválido ou em falta");
  }
}

// Mapa de comando -> path antigo, para inferir o comando quando o corpo não traz `command`
// (mantém as rotas /callback/win, /callback/cancel e /callback/status a funcionar caso o painel
// do provedor já tenha sido configurado com URLs separadas em vez de uma só).
const COMMAND_BY_PATH: Record<string, string> = {
  authenticate: "authenticate",
  balance: "balance",
  bet: "bet",
  win: "win",
  cancel: "cancel",
  status: "status",
};

async function dispatchCasinoCallback(command: string, data: CasinoCallbackData & { account?: string }) {
  switch (command) {
    case "authenticate":
      return handleAuthenticateCallback(data.account ?? "");
    case "balance":
      return handleBalanceCallback(data.account ?? "");
    case "bet":
      return handleBetCallback(data);
    case "win":
      return handleWinCallback(data);
    case "cancel":
      return handleCancelCallback(data);
    case "status":
      return handleStatusCallback(data.account ?? "", data.trans_guid);
    default:
      return { result: 1002, status: "UNKNOWN_COMMAND", data: {} };
  }
}

function casinoCallbackHandler(pathCommand?: string) {
  return asyncHandler(async (req, res) => {
    try {
      verifyCallbackToken(req);
      const command = typeof req.body?.command === "string" ? req.body.command : pathCommand ?? "";
      const data = (req.body?.data ?? {}) as CasinoCallbackData & { account?: string };
      const result = await dispatchCasinoCallback(command, data);
      res.json(result);
    } catch (err) {
      res.json(toCallbackErrorResponse(err));
    }
  });
}

// URL principal a configurar no painel de agente do provedor.
router.post("/callback", casinoCallbackHandler());

// Aliases (mesma lógica, comando inferido do path se o corpo não o trouxer).
for (const [path, command] of Object.entries(COMMAND_BY_PATH)) {
  router.post(`/callback/${path}`, casinoCallbackHandler(command));
}

export default router;
