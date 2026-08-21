import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import type { KycDocumentType } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { Errors } from "../../lib/errors";
import { env } from "../../config/env";

// Documentos de verificação KYC (documento pessoal + extrato bancário para validar o IBAN) —
// ver docs/KYC_DOCUMENTS.md. Guardados em disco local sob KYC_UPLOAD_DIR — NEEDS VALIDATION
// antes de produção: o sistema de ficheiros do Railway é efémero sem um volume persistente
// montado nesse caminho, um redeploy apaga tudo o que já foi enviado.
export const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
export const MAX_FILE_SIZE_BYTES = 8 * 1024 * 1024; // 8MB

function uploadRoot(): string {
  return path.isAbsolute(env.KYC_UPLOAD_DIR) ? env.KYC_UPLOAD_DIR : path.join(process.cwd(), env.KYC_UPLOAD_DIR);
}

// Nunca usa o nome de ficheiro enviado pelo cliente para o caminho no disco (risco de path
// traversal, ex: "../../etc/passwd") — gera sempre um nome opaco; o nome original só fica
// guardado no registo da base de dados, para mostrar na UI.
function safeExtension(mimeType: string): string {
  const map: Record<string, string> = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "application/pdf": ".pdf" };
  return map[mimeType] ?? "";
}

export async function saveKycDocument(params: { userId: string; type: KycDocumentType; file: { originalname: string; mimetype: string; size: number; buffer: Buffer } }) {
  if (!ALLOWED_MIME_TYPES.includes(params.file.mimetype)) {
    throw Errors.badRequest("Formato de ficheiro não suportado. Envie uma imagem (JPG/PNG/WEBP) ou PDF.");
  }
  if (params.file.size > MAX_FILE_SIZE_BYTES) {
    throw Errors.badRequest(`Ficheiro demasiado grande (máximo ${MAX_FILE_SIZE_BYTES / 1024 / 1024}MB).`);
  }

  const userDir = path.join(uploadRoot(), params.userId);
  await fs.mkdir(userDir, { recursive: true });
  const storageFileName = `${crypto.randomUUID()}${safeExtension(params.file.mimetype)}`;
  await fs.writeFile(path.join(userDir, storageFileName), params.file.buffer);

  return prisma.kycDocument.create({
    data: {
      userId: params.userId,
      type: params.type,
      fileName: params.file.originalname.slice(0, 255),
      storagePath: path.join(params.userId, storageFileName),
      mimeType: params.file.mimetype,
      sizeBytes: params.file.size,
    },
  });
}

export async function listMyKycDocuments(userId: string) {
  return prisma.kycDocument.findMany({ where: { userId }, orderBy: { uploadedAt: "desc" } });
}

/** Devolve o caminho absoluto no disco de um documento, só depois de confirmar que pertence ao
 * utilizador indicado (ou, para o admin, sem essa restrição — ver admin/service.ts). Nunca
 * serve um documento sem esta verificação de posse. */
export async function getKycDocumentFile(documentId: string, requestingUserId: string | null) {
  const doc = await prisma.kycDocument.findUnique({ where: { id: documentId } });
  if (!doc) throw Errors.notFound("Documento não encontrado");
  if (requestingUserId !== null && doc.userId !== requestingUserId) throw Errors.notFound("Documento não encontrado");
  return { doc, absolutePath: path.join(uploadRoot(), doc.storagePath) };
}
