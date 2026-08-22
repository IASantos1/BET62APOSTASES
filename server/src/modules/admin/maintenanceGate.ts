import type { NextFunction, Request, Response } from "express";
import { getMaintenanceMode } from "./service";

// Aplicado globalmente em app.ts a todos os pedidos /api/* — exceto ao próprio painel admin
// (para o admin conseguir sempre entrar e desligar a manutenção) e ao login/refresh/logout
// (para o admin conseguir mesmo AUTENTICAR-SE, já que /api/admin/* exige um token válido).
const EXEMPT_PREFIXES = ["/api/admin", "/api/auth/login", "/api/auth/refresh", "/api/auth/logout", "/api/health"];

export async function maintenanceGate(req: Request, res: Response, next: NextFunction) {
  if (!req.path.startsWith("/api/")) return next(); // frontend estático sempre servido
  if (EXEMPT_PREFIXES.some((p) => req.path.startsWith(p))) return next();

  if (await getMaintenanceMode()) {
    return res.status(503).json({
      error: { code: "MAINTENANCE", message: "Plataforma em manutenção. Volte a tentar dentro de momentos." },
    });
  }
  next();
}
