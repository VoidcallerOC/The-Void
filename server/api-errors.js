export class ApiError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function apiErrorFrom(error) {
  if (error instanceof ApiError) return error;
  if (error?.code === "VALIDATION_ERROR") return new ApiError(400, error.code, error.message, error.field ? { field: error.field } : null);
  if (error?.code === "CONFLICT") return new ApiError(409, error.code, error.message);
  if (error?.code === "23503") return new ApiError(409, "REFERENCE_CONFLICT", "The requested record references missing or invalid data.");
  if (error?.status && error?.code) return new ApiError(error.status, error.code, error.message);
  return new ApiError(500, "INTERNAL_ERROR", "The request could not be completed.");
}

export function errorResponse(error, requestId) {
  const normalized = apiErrorFrom(error);
  return { error: { code: normalized.code, message: normalized.message, details: normalized.details, requestId } };
}

export function okResponse(data, requestId) {
  return { data, requestId };
}
