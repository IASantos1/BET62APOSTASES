import crypto from "crypto";
import type { Request, Response } from "express";
import { env, isProd } from "../config/env";
import { Errors } from "./errors";

const CSRF_COOKIE = "bet62_csrf";
const CSRF_HEADER = "x-csrf-token";
const CSRF_BYTES = 32;
const CSRF_TTL_MS = 6 * 60 * 60 * 1000;

function csrfCookieOptions(req: Request): import("express").CookieOptions {
  return {
    httpOnly: false,
    sameSite: "lax",
    secure: isProd || req.protocol === "https",
    maxAge: CSRF_TTL_MS,
    path: "/",
  };
}

function hashToken(token: string): string {
  return crypto.createHmac("sha256", env.JWT_ACCESS_SECRET).update(token).digest("hex");
}

export function generateCsrfToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(CSRF_BYTES).toString("base64url");
  return { token, hash: hashToken(token) };
}

export function ensureCsrfCookie(req: Request, res: Response): string {
  const existing = req.cookies?.[CSRF_COOKIE] as string | undefined;
  if (existing) return existing;
  const { token } = generateCsrfToken();
  res.cookie(CSRF_COOKIE, token, csrfCookieOptions(req));
  return token;
}

export function validateCsrf(req: Request): void {
  const header = req.headers[CSRF_HEADER] as string | undefined;
  const cookie = req.cookies?.[CSRF_COOKIE] as string | undefined;
  if (!header || !cookie) throw Errors.forbidden("CSRF token em falta");
  if (hashToken(cookie) !== hashToken(header)) throw Errors.forbidden("CSRF token inválido");
}
