import type { NextFunction, Request, Response } from "express";
import { getMaintenanceMode } from "./service";

// Aplicado globalmente em app.ts a todos os pedidos /api/* — exceto ao próprio painel admin
// (para o admin conseguir sempre entrar e desligar a manutenção), ao login/refresh/logout
// (para o admin conseguir mesmo AUTENTICAR-SE, já que /api/admin/* exige um token válido), e ao
// callback do Cassino (a Palace Casino chama-nos de fora para debitar/creditar apostas em
// tempo real — bloquear isto durante uma manutenção deixaria jogadas em curso presas sem o
// saldo correspondente a ser movido, e o próprio provedor testa este URL antes de lançar
// qualquer jogo, mesmo sem manutenção nenhuma ligada — nunca deve depender deste interruptor).
const EXEMPT_PREFIXES = ["/api/admin", "/api/auth/login", "/api/auth/refresh", "/api/auth/logout", "/api/health", "/api/casino/callback"];

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
