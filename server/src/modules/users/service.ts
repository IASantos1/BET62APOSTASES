import { prisma } from "../../lib/prisma";
import { Errors } from "../../lib/errors";

export async function getProfile(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    include: { limits: true, kycSubmissions: { orderBy: { createdAt: "desc" }, take: 1 } },
  });

  return {
    id: user.publicId,
    name: user.name,
    email: user.email,
    username: user.username,
    phone: user.phone,
    birthDate: user.birthDate,
    addressLine: user.addressLine,
    currency: user.currency,
    locale: user.locale,
    oddsFormat: user.oddsFormat,
    status: user.status,
    kycStatus: user.kycSubmissions[0]?.status ?? "NOT_STARTED",
    limits: user.limits,
  };
}

export interface UpdatePersonalInput {
  name?: string;
  phone?: string;
  addressLine?: string;
}

export async function updatePersonalInfo(userId: string, input: UpdatePersonalInput) {
  await prisma.user.update({
    where: { id: userId },
    data: {
      name: input.name,
      phone: input.phone,
      addressLine: input.addressLine,
    },
  });
  return getProfile(userId);
}

export async function updatePreferences(
  userId: string,
  input: { locale?: string; currency?: string; oddsFormat?: string }
) {
  await prisma.user.update({ where: { id: userId }, data: input });
  return getProfile(userId);
}

export async function submitKyc(userId: string, docType: "CITIZEN_CARD" | "PASSPORT" | "DRIVING_LICENSE", docNumber: string) {
  const pending = await prisma.kycSubmission.findFirst({
    where: { userId, status: { in: ["PENDING", "IN_REVIEW"] } },
  });
  if (pending) throw Errors.conflict("Já existe uma verificação em curso");

  const submission = await prisma.kycSubmission.create({
    data: { userId, docType, docNumber, status: "PENDING" },
  });

  await prisma.auditLog.create({ data: { userId, action: "KYC_SUBMITTED", metadata: { docType } } });

  return submission;
}

export async function updateLimits(
  userId: string,
  input: { dailyDepositLimit?: number; weeklyLossLimit?: number; sessionTimeLimitMinutes?: number; realityCheckEnabled?: boolean }
) {
  // Responsible-gambling rule: limits can only be tightened instantly.
  // Raising a limit is deferred (24h cooling-off) — enforced by callers checking `pendingIncreaseAt`.
  const current = await prisma.responsibleGamblingLimits.findUniqueOrThrow({ where: { userId } });

  const isIncrease =
    (input.dailyDepositLimit !== undefined && input.dailyDepositLimit > Number(current.dailyDepositLimit)) ||
    (input.weeklyLossLimit !== undefined && input.weeklyLossLimit > Number(current.weeklyLossLimit));

  if (isIncrease) {
    throw Errors.badRequest(
      "Aumentar limites requer um período de reflexão de 24h. Contacte o suporte para processar este pedido com o período de arrefecimento aplicável."
    );
  }

  const updated = await prisma.responsibleGamblingLimits.update({
    where: { userId },
    data: input,
  });

  await prisma.auditLog.create({ data: { userId, action: "LIMITS_UPDATED", metadata: input } });

  return updated;
}

export async function selfExclude(userId: string, days: number | null, reason?: string) {
  const endAt = days ? new Date(Date.now() + days * 86_400_000) : null;

  await prisma.$transaction([
    prisma.selfExclusion.create({ data: { userId, endAt, reason, active: true } }),
    prisma.user.update({ where: { id: userId }, data: { status: "SELF_EXCLUDED" } }),
    prisma.auditLog.create({
      data: { userId, action: "SELF_EXCLUSION_ACTIVATED", metadata: { days, permanent: days === null } },
    }),
  ]);

  return { active: true, endAt, permanent: days === null };
}

export async function isSelfExcluded(userId: string): Promise<boolean> {
  const active = await prisma.selfExclusion.findFirst({
    where: { userId, active: true, OR: [{ endAt: null }, { endAt: { gt: new Date() } }] },
  });
  return Boolean(active);
}
