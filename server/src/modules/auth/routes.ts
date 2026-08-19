import { Router } from "express";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { asyncHandler } from "../../middleware/errorHandler";
import { validateBody } from "../../middleware/validate";
import { loginUser, registerUser, rotateRefreshToken, revokeRefreshToken } from "./service";

const router = Router();

const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: "TOO_MANY_REQUESTS", message: "Demasiadas tentativas. Tente mais tarde." } },
});

const registerSchema = z.object({
  name: z.string().min(2).max(120),
  email: z.string().email(),
  username: z
    .string()
    .min(3)
    .max(24)
    .regex(/^[a-zA-Z0-9_]+$/, "Apenas letras, números e underscore"),
  password: z.string().min(8, "Senha mínima de 8 caracteres"),
  birthDate: z.string(),
  acceptedTerms: z.literal(true, { errorMap: () => ({ message: "Tem de aceitar os termos" }) }),
});

const loginSchema = z.object({
  identifier: z.string().min(1),
  password: z.string().min(1),
});

const refreshSchema = z.object({ refreshToken: z.string().min(1) });

router.post(
  "/register",
  authRateLimit,
  validateBody(registerSchema),
  asyncHandler(async (req, res) => {
    const tokens = await registerUser({
      ...req.body,
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
    res.status(201).json(tokens);
  })
);

router.post(
  "/login",
  authRateLimit,
  validateBody(loginSchema),
  asyncHandler(async (req, res) => {
    const tokens = await loginUser(req.body.identifier, req.body.password, req.ip, req.headers["user-agent"]);
    res.json(tokens);
  })
);

router.post(
  "/refresh",
  validateBody(refreshSchema),
  asyncHandler(async (req, res) => {
    const tokens = await rotateRefreshToken(req.body.refreshToken, req.ip, req.headers["user-agent"]);
    res.json(tokens);
  })
);

router.post(
  "/logout",
  validateBody(refreshSchema),
  asyncHandler(async (req, res) => {
    await revokeRefreshToken(req.body.refreshToken);
    res.status(204).end();
  })
);

export default router;
