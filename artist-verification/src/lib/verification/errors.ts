export type VerificationErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "VALIDATION"
  | "NOT_FOUND"
  | "DUPLICATE"
  | "RATE_LIMITED"
  | "INVALID_TRANSITION"
  | "UNAVAILABLE"
  | "CONFLICT";

export class VerificationError extends Error {
  readonly code: VerificationErrorCode;
  readonly status: number;
  readonly fields?: Record<string, string>;

  constructor(
    code: VerificationErrorCode,
    message: string,
    status: number,
    fields?: Record<string, string>,
  ) {
    super(message);
    this.name = "VerificationError";
    this.code = code;
    this.status = status;
    this.fields = fields;
  }
}

export function publicErrorMessage(error: unknown): { message: string; code: string; status: number; fields?: Record<string, string> } {
  if (error instanceof VerificationError) {
    return { message: error.message, code: error.code, status: error.status, fields: error.fields };
  }
  if (error instanceof Error && error.message === "Unauthorized") {
    return { message: "Sign in to continue.", code: "UNAUTHORIZED", status: 401 };
  }
  return {
    message: "The Void could not complete this request. Try again shortly.",
    code: "UNAVAILABLE",
    status: 503,
  };
}
