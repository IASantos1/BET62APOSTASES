import type { NextFunction, Request, Response } from "express";
import { verifyAccessToken } from "../lib/jwt";
import { Errors } from "../lib/errors";
import { validateCsrf } from "../lib/csrf";

export interface AuthedRequest extends Request {
  user?: { id: string; role: "USER" | "SUPPORT" | "ADMIN" };
  authMode?: "bearer" | "cookie";
}

const ACCESS_COOKIE = "bet62_access";

export function requireAuth(req: AuthedRequest, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const cookieToken: string | undefined = req.cookies?.[ACCESS_COOKIE];

  let token: string | null = null;
  let mode: "bearer" | "cookie" | null = null;

  if (header?.startsWith("Bearer ")) {
    token = header.slice("Bearer ".length);
    mode = "bearer";
  } else if (cookieToken) {
    token = cookieToken;
    mode = "cookie";
  }

  if (!token || !mode) return next(Errors.unauthorized());

  try {
    const payload = verifyAccessToken(token);
    req.user = { id: payload.sub, role: payload.role };
    req.authMode = mode;
  } catch {
    return next(Errors.unauthorized("Sessão expirada ou inválida"));
  }

  const isRead = req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS";
  if (mode === "cookie" && !isRead) {
    try {
      validateCsrf(req);
    } catch (err) {
      return next(err);
    }
  }

  next();
}

export function requireRole(...roles: Array<"USER" | "SUPPORT" | "ADMIN">) {
  return (req: AuthedRequest, _res: Response, next: NextFunction) => {
    if (!req.user) return next(Errors.unauthorized());
    if (!roles.includes(req.user.role)) return next(Errors.forbidden());
    next();
  };
}
