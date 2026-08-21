import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { asyncHandler } from "../../middleware/errorHandler";
import { requireAuth, type AuthedRequest } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { Errors } from "../../lib/errors";
import {
  getProfile,
  selfExclude,
  submitKyc,
  updateLimits,
  updatePersonalInfo,
  updatePreferences,
} from "./service";
import { getKycDocumentFile, listMyKycDocuments, saveKycDocument, MAX_FILE_SIZE_BYTES } from "./kycDocuments";

const router = Router();
router.use(requireAuth);

// Memória, não disco temporário — os ficheiros são pequenos (imagem/PDF de um documento) e
// saveKycDocument() já escreve o resultado final direto para KYC_UPLOAD_DIR.
const kycUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_SIZE_BYTES } });

router.get(
  "/me",
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json(await getProfile(req.user!.id));
  })
);

router.patch(
  "/me",
  validateBody(
    z.object({
      name: z.string().min(2).max(120).optional(),
      phone: z.string().max(30).optional(),
      addressLine: z.string().max(200).optional(),
    })
  ),
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json(await updatePersonalInfo(req.user!.id, req.body));
  })
);

router.patch(
  "/me/preferences",
  validateBody(
    z.object({
      locale: z.enum(["pt", "en", "es"]).optional(),
      currency: z.enum(["EUR", "BRL", "USD"]).optional(),
      oddsFormat: z.enum(["decimal", "fractional", "american"]).optional(),
    })
  ),
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json(await updatePreferences(req.user!.id, req.body));
  })
);

router.post(
  "/me/kyc",
  validateBody(
    z.object({
      docType: z.enum(["CITIZEN_CARD", "PASSPORT", "DRIVING_LICENSE"]),
      docNumber: z.string().min(3).max(40),
    })
  ),
  asyncHandler(async (req: AuthedRequest, res) => {
    res.status(201).json(await submitKyc(req.user!.id, req.body.docType, req.body.docNumber));
  })
);

// Documento pessoal (identidade) e extrato bancário (para validar o IBAN) — ver
// docs/KYC_DOCUMENTS.md. `type` vem no corpo multipart junto com o ficheiro em `file`.
router.post(
  "/me/kyc/documents",
  kycUpload.single("file"),
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!req.file) throw Errors.badRequest("Nenhum ficheiro enviado");
    const type = req.body.type === "BANK_STATEMENT" ? "BANK_STATEMENT" : req.body.type === "ID_DOCUMENT" ? "ID_DOCUMENT" : null;
    if (!type) throw Errors.badRequest('Parâmetro "type" tem de ser ID_DOCUMENT ou BANK_STATEMENT');
    const doc = await saveKycDocument({ userId: req.user!.id, type, file: req.file });
    res.status(201).json(doc);
  })
);

router.get(
  "/me/kyc/documents",
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json({ documents: await listMyKycDocuments(req.user!.id) });
  })
);

router.get(
  "/me/kyc/documents/:id/file",
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!req.params.id) throw Errors.badRequest("Parâmetro id em falta");
    const { doc, absolutePath } = await getKycDocumentFile(req.params.id, req.user!.id);
    res.setHeader("Content-Type", doc.mimeType);
    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(doc.fileName)}"`);
    res.sendFile(absolutePath);
  })
);

router.patch(
  "/me/limits",
  validateBody(
    z.object({
      dailyDepositLimit: z.number().nonnegative().optional(),
      weeklyLossLimit: z.number().nonnegative().optional(),
      sessionTimeLimitMinutes: z.number().int().min(1).max(24 * 60).optional(),
      realityCheckEnabled: z.boolean().optional(),
    })
  ),
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json(await updateLimits(req.user!.id, req.body));
  })
);

router.post(
  "/me/self-exclusion",
  validateBody(
    z.object({
      days: z.union([z.literal(1), z.literal(7), z.literal(30), z.literal(90), z.null()]),
      reason: z.string().max(500).optional(),
    })
  ),
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json(await selfExclude(req.user!.id, req.body.days, req.body.reason));
  })
);

export default router;
