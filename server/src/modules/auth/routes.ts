import { Router } from "express";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import type { Request, Response } from "express";
import ms from "ms";
import { asyncHandler } from "../../middleware/errorHandler";
import { validateBody } from "../../middleware/validate";
import { loginUser, registerUser, rotateRefreshToken, revokeRefreshToken } from "./service";
import { env, isProd } from "../../config/env";
import { ensureCsrfCookie, validateCsrf } from "../../lib/csrf";
import { Errors } from "../../lib/errors";
import { getProfile } from "../users/service";

const router = Router();

const ACCESS_COOKIE = "bet62_access";
const REFRESH_COOKIE = "bet62_refresh";

function cookieOpts(req: Request, secureOverride?: boolean) {
  const secure = secureOverride ?? (isProd || req.protocol === "https");
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure,
    path: "/",
  } as const;
}

function accessTtlMs(): number {
  try {
    return (ms as unknown as (s: string) => number)(env.JWT_ACCESS_TTL);
  } catch {
    return 15 * 60 * 1000;
  }
}

function refreshTtlMs(): number {
  return env.JWT_REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000;
}

function setAuthCookies(req: Request, res: Response, access: string, refresh: string) {
  res.cookie(ACCESS_COOKIE, access, {
    ...cookieOpts(req),
    maxAge: accessTtlMs(),
  });
  res.cookie(REFRESH_COOKIE, refresh, {
    ...cookieOpts(req),
    maxAge: refreshTtlMs(),
  });
}

function clearAuthCookies(req: Request, res: Response) {
  const base = cookieOpts(req);
  res.clearCookie(ACCESS_COOKIE, { path: base.path, httpOnly: base.httpOnly, sameSite: base.sameSite, secure: base.secure });
  res.clearCookie(REFRESH_COOKIE, { path: base.path, httpOnly: base.httpOnly, sameSite: base.sameSite, secure: base.secure });
}

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

router.get("/csrf", (_req, res) => {
  const csrf = ensureCsrfCookie(_req, res);
  res.json({ csrfToken: csrf });
});

router.get("/session", asyncHandler(async (req, res) => {
  const access: string | undefined = req.cookies?.[ACCESS_COOKIE] ?? null;
  const header = req.headers.authorization;
  let token: string | null = access && typeof access === "string" ? access : null;
  if (header?.startsWith("Bearer ")) token = header.slice("Bearer ".length);
  if (!token) return res.json({ authenticated: false });
  try {
    const { verifyAccessToken } = await import("../../lib/jwt");
    const payload = verifyAccessToken(token);
    const profile = await getProfile(payload.sub);
    ensureCsrfCookie(req, res);
    return res.json({ authenticated: true, user: profile, csrfToken: ensureCsrfCookie(req, res) });
  } catch {
    clearAuthCookies(req, res);
    return res.json({ authenticated: false });
  }
}));

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
    setAuthCookies(req, res, tokens.accessToken, tokens.refreshToken);
    ensureCsrfCookie(req, res);
    res.status(201).json(tokens);
  })
);

router.post(
  "/login",
  authRateLimit,
  validateBody(loginSchema),
  asyncHandler(async (req, res) => {
    const tokens = await loginUser(req.body.identifier, req.body.password, req.ip, req.headers["user-agent"]);
    setAuthCookies(req, res, tokens.accessToken, tokens.refreshToken);
    ensureCsrfCookie(req, res);
    res.json(tokens);
  })
);

router.post(
  "/refresh",
  validateBody(refreshSchema.partial()),
  asyncHandler(async (req, res) => {
    let refresh = req.body?.refreshToken as string | undefined;
    if (!refresh) {
      const cookie = req.cookies?.[REFRESH_COOKIE];
      if (typeof cookie === "string" && cookie) refresh = cookie;
    }
    if (!refresh) throw Errors.unauthorized("Refresh token em falta");
    const isRead = false;
    const cookieMode: boolean = req.cookies?.[REFRESH_COOKIE] === refresh && !req.body?.refreshToken;
    if (cookieMode && !isRead) {
      try {
        validateCsrf(req);
      } catch (err) {
        return res.status(403).json({ error: { code: (err as any).code ?? "FORBIDDEN", message: (err as any).message ?? "CSRF inválido" } });
      }
    }
    const tokens = await rotateRefreshToken(refresh, req.ip, req.headers["user-agent"]);
    setAuthCookies(req, res, tokens.accessToken, tokens.refreshToken);
    ensureCsrfCookie(req, res);
    res.json(tokens);
  })
);

router.post(
  "/logout",
  validateBody(refreshSchema.partial()),
  asyncHandler(async (req, res) => {
    let refresh = req.body?.refreshToken as string | undefined;
    if (!refresh) {
      const cookie = req.cookies?.[REFRESH_COOKIE];
      if (typeof cookie === "string" && cookie) refresh = cookie;
    }
    if (refresh) {
      try {
        await revokeRefreshToken(refresh);
      } catch {}
    }
    clearAuthCookies(req, res);
    res.status(204).end();
  })
);

export default router;
