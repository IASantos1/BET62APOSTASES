import bcrypt from "bcryptjs";
import { prisma } from "../../lib/prisma";
import { Errors } from "../../lib/errors";
import {
  generateRefreshToken,
  hashRefreshToken,
  refreshTokenExpiryDate,
  signAccessToken,
} from "../../lib/jwt";

const MIN_AGE_YEARS = 18;

function isAdult(birthDate: Date): boolean {
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - MIN_AGE_YEARS);
  return birthDate <= cutoff;
}

export interface RegisterInput {
  name: string;
  email: string;
  username: string;
  password: string;
  birthDate: string; // ISO date
  acceptedTerms: boolean;
  ip?: string;
  userAgent?: string;
}

export async function registerUser(input: RegisterInput) {
  if (!input.acceptedTerms) {
    throw Errors.badRequest("É necessário aceitar os Termos e a Política de Privacidade");
  }

  const birth = new Date(input.birthDate);
  if (Number.isNaN(birth.getTime()) || !isAdult(birth)) {
    throw Errors.badRequest("É necessário ter pelo menos 18 anos para se registar (jogo responsável)");
  }

  const existing = await prisma.user.findFirst({
    where: { OR: [{ email: input.email }, { username: input.username }] },
  });
  if (existing) throw Errors.conflict("E-mail ou nome de utilizador já registado");

  const passwordHash = await bcrypt.hash(input.password, 12);

  const user = await prisma.user.create({
    data: {
      email: input.email,
      username: input.username,
      name: input.name,
      passwordHash,
      birthDate: birth,
      wallet: { create: { currency: "EUR", balance: 0 } },
      limits: { create: {} },
    },
    include: { wallet: true },
  });

  await prisma.auditLog.create({
    data: { userId: user.id, action: "USER_REGISTERED", ip: input.ip, metadata: { userAgent: input.userAgent } },
  });

  return issueSession(user.id, user.role, input.ip, input.userAgent);
}

export async function loginUser(identifier: string, password: string, ip?: string, userAgent?: string) {
  const user = await prisma.user.findFirst({
    where: { OR: [{ email: identifier }, { username: identifier }] },
  });
  if (!user) throw Errors.unauthorized("Credenciais inválidas");

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) throw Errors.unauthorized("Credenciais inválidas");

  if (user.status === "SUSPENDED" || user.status === "CLOSED") {
    throw Errors.forbidden("Conta suspensa ou encerrada. Contacte o suporte.");
  }

  const activeExclusion = await prisma.selfExclusion.findFirst({
    where: { userId: user.id, active: true, OR: [{ endAt: null }, { endAt: { gt: new Date() } }] },
  });
  if (activeExclusion || user.status === "SELF_EXCLUDED") {
    throw Errors.selfExcluded();
  }

  await prisma.auditLog.create({ data: { userId: user.id, action: "USER_LOGIN", ip, metadata: { userAgent } } });

  return issueSession(user.id, user.role, ip, userAgent);
}

async function issueSession(userId: string, role: "USER" | "SUPPORT" | "ADMIN", ip?: string, userAgent?: string) {
  const accessToken = signAccessToken({ sub: userId, role });
  const { token: refreshToken, tokenHash } = generateRefreshToken();

  await prisma.refreshToken.create({
    data: { userId, tokenHash, ip, userAgent, expiresAt: refreshTokenExpiryDate() },
  });

  return { accessToken, refreshToken };
}

export async function rotateRefreshToken(refreshToken: string, ip?: string, userAgent?: string) {
  const tokenHash = hashRefreshToken(refreshToken);
  const stored = await prisma.refreshToken.findUnique({ where: { tokenHash }, include: { user: true } });

  if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
    throw Errors.unauthorized("Refresh token inválido ou expirado");
  }

  await prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });

  return issueSession(stored.userId, stored.user.role, ip, userAgent);
}

export async function revokeRefreshToken(refreshToken: string) {
  const tokenHash = hashRefreshToken(refreshToken);
  await prisma.refreshToken.updateMany({
    where: { tokenHash, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
