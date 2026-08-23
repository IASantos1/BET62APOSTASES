export class AppError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const Errors = {
  unauthorized: (message = "Não autenticado") => new AppError(401, "UNAUTHORIZED", message),
  forbidden: (message = "Sem permissão") => new AppError(403, "FORBIDDEN", message),
  notFound: (message = "Recurso não encontrado") => new AppError(404, "NOT_FOUND", message),
  badRequest: (message: string, details?: unknown) =>
    new AppError(400, "BAD_REQUEST", message, details),
  conflict: (message: string) => new AppError(409, "CONFLICT", message),
  tooManyRequests: (message = "Demasiados pedidos, tente mais tarde") =>
    new AppError(429, "TOO_MANY_REQUESTS", message),
  selfExcluded: (message = "Conta autoexcluída. Não é possível realizar esta ação.") =>
    new AppError(403, "SELF_EXCLUDED", message),
  kycRequired: (message = "Verificação de identidade (KYC) necessária para esta ação") =>
    new AppError(403, "KYC_REQUIRED", message),
  internal: (message = "Erro interno do servidor", details?: unknown) =>
    new AppError(500, "INTERNAL_ERROR", message, details),
};
