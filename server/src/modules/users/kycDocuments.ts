import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import type { KycDocumentType } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { Errors } from "../../lib/errors";
import { env } from "../../config/env";
import { logger } from "../../lib/logger";

// Documentos de verificação KYC (documento pessoal + extrato bancário para validar o IBAN) —
// ver docs/KYC_DOCUMENTS.md. Modo local guarda em KYC_UPLOAD_DIR em disco ( Railway sem volume
// = EFÉMERO ). Alternativa recomendada produção: Cloudflare R2 / AWS S3 com ACLs IAM e URLs
// pré-assinadas (passo-a-passo em docs/KYC_DOCUMENTS.md seção "Armazenamento em R2/S3").
export const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
export const MAX_FILE_SIZE_BYTES = 8 * 1024 * 1024; // 8MB

const SIGNATURES: Array<{ mime: string; bytes: number[] }> = [
  { mime: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { mime: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47] },
  { mime: "image/webp", bytes: [0x52, 0x49, 0x46, 0x46] },
  { mime: "application/pdf", bytes: [0x25, 0x50, 0x44, 0x46] },
];

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

/**
 * Verificação dupla da natureza real do ficheiro: a) mimetype declarado no upload, b) magic
 * bytes do início do buffer (impede bypass tipo renomear .exe para .pdf e o browser
 * servir/executar se o Content-Type for derivado da extensão, e impede sobreposição de headers
 * de tipo do servidor). Detecta mismatch e rejeita cedo.
 */
function detectMimeFromBytes(buffer: Buffer): string | null {
  for (const sig of SIGNATURES) {
    if (buffer.length < sig.bytes.length) continue;
    let ok = true;
    for (let i = 0; i < sig.bytes.length; i++) {
      if (buffer[i] !== sig.bytes[i]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      if (sig.mime === "image/webp") {
        if (buffer.length >= 12 && buffer.slice(8, 12).toString("ascii") === "WEBP") return "image/webp";
        return null;
      }
      return sig.mime;
    }
  }
  return null;
}

/**
 * Escapar o filename do Content-Disposition — previne header injection (CRLF no filename
 * original do cliente) e usa o fallback ASCII com RFC 5987 UTF-8 encoded para nomes com
 * acentos/Unicode.
 */
export function safeContentDisposition(filename: string): string {
  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, "_").replace(/[;":\\]/g, "_");
  const utf8Encoded = encodeURIComponent(filename);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${utf8Encoded}`;
}

export async function saveKycDocument(params: {
  userId: string;
  type: KycDocumentType;
  file: { originalname: string; mimetype: string; size: number; buffer: Buffer };
}) {
  if (!ALLOWED_MIME_TYPES.includes(params.file.mimetype)) {
    throw Errors.badRequest("Formato de ficheiro não suportado. Envie uma imagem (JPG/PNG/WEBP) ou PDF.");
  }
  if (params.file.size > MAX_FILE_SIZE_BYTES) {
    throw Errors.badRequest(`Ficheiro demasiado grande (máximo ${MAX_FILE_SIZE_BYTES / 1024 / 1024}MB).`);
  }
  const actualMime = detectMimeFromBytes(params.file.buffer);
  if (!actualMime || actualMime !== params.file.mimetype) {
    logger.warn(
      { userId: params.userId, claimed: params.file.mimetype, detected: actualMime, name: params.file.originalname },
      "KYC upload: mime vs bytes mismatch — rejeitado"
    );
    throw Errors.badRequest("Conteúdo do ficheiro não corresponde ao formato indicado. Envie uma imagem ou PDF real.");
  }

  const userDir = path.join(uploadRoot(), params.userId);
  await fs.mkdir(userDir, { recursive: true });

  const storageFileName = `${crypto.randomUUID()}${safeExtension(actualMime)}`;
  const storagePath = path.join(params.userId, storageFileName);
  const absolute = path.join(uploadRoot(), storagePath);

  const modeMask = process.platform === "win32" ? undefined : 0o600;
  await fs.writeFile(absolute, params.file.buffer, { mode: modeMask });

  const hash = crypto.createHash("sha256").update(params.file.buffer).digest("hex");

  await prisma.auditLog.create({
    data: {
      userId: params.userId,
      action: "KYC_DOCUMENT_UPLOADED",
      metadata: { type: params.type, mimeType: actualMime, sizeBytes: params.file.size, sha256: hash },
    },
  });

  return prisma.kycDocument.create({
    data: {
      userId: params.userId,
      type: params.type,
      fileName: params.file.originalname.slice(0, 255),
      storagePath,
      mimeType: actualMime,
      sizeBytes: params.file.size,
      sha256: hash,
      status: "PENDING",
    },
  });
}

export async function listMyKycDocuments(userId: string) {
  return prisma.kycDocument.findMany({
    where: { userId },
    orderBy: { uploadedAt: "desc" },
    select: {
      id: true,
      type: true,
      fileName: true,
      mimeType: true,
      sizeBytes: true,
      uploadedAt: true,
      status: true,
      reviewedAt: true,
      reviewedByUserId: true,
      reviewNotes: true,
    },
  });
}

/**
 * Devolve o caminho absoluto no disco de um documento, só depois de confirmar que pertence ao
 * utilizador indicado (ou, para o admin, sem essa restrição — ver admin/service.ts). Nunca
 * serve um documento sem esta verificação de posse.
 */
export async function getKycDocumentFile(documentId: string, requestingUserId: string | null) {
  const doc = await prisma.kycDocument.findUnique({ where: { id: documentId } });
  if (!doc) throw Errors.notFound("Documento não encontrado");
  if (requestingUserId !== null && doc.userId !== requestingUserId) throw Errors.notFound("Documento não encontrado");
  return { doc, absolutePath: path.join(uploadRoot(), doc.storagePath) };
}
