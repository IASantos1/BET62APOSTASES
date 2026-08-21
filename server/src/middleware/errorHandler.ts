import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { MulterError } from "multer";
import { AppError } from "../lib/errors";
import { logger } from "../lib/logger";

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ error: { code: "NOT_FOUND", message: "Rota não encontrada" } });
}

// Nomes de erro que o Multer usa (multer/lib/multer-error.js) — só os que este projeto pode
// mesmo disparar (upload de documentos KYC: um campo de ficheiro, limite de tamanho e tipo).
const MULTER_ERROR_MESSAGES: Record<string, string> = {
  LIMIT_FILE_SIZE: "Ficheiro demasiado grande.",
  LIMIT_UNEXPECTED_FILE: "Campo de ficheiro inesperado.",
};

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Dados inválidos",
        details: err.flatten(),
      },
    });
  }

  // multer lança os seus próprios erros (limite de tamanho/campo inesperado) ANTES do handler
  // da rota sequer correr — não são AppError, mas também não são um erro interno real, por
  // isso ganham o mesmo tratamento 400 limpo em vez de cair no 500 genérico abaixo.
  if (err instanceof MulterError) {
    return res.status(400).json({
      error: { code: "BAD_REQUEST", message: MULTER_ERROR_MESSAGES[err.code] ?? err.message },
    });
  }

  if (err instanceof AppError) {
    if (err.status >= 500) logger.error({ err }, err.message);
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
  }

  logger.error({ err }, "Erro não tratado");
  return res.status(500).json({
    error: { code: "INTERNAL_ERROR", message: "Erro interno do servidor" },
  });
}

export function asyncHandler<T extends (...args: any[]) => Promise<any>>(fn: T) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}
