export class PersistenceValidationError extends Error {
  constructor(message, field = null) {
    super(message);
    this.name = "PersistenceValidationError";
    this.field = field;
    this.code = "VALIDATION_ERROR";
  }
}

export class PersistenceConflictError extends Error {
  constructor(message, cause = null) {
    super(message, { cause });
    this.name = "PersistenceConflictError";
    this.code = "CONFLICT";
  }
}

export function requiredText(value, field, { max = 512 } = {}) {
  const text = String(value ?? "").trim();
  if (!text) throw new PersistenceValidationError(`${field} is required.`, field);
  if (text.length > max) throw new PersistenceValidationError(`${field} exceeds ${max} characters.`, field);
  return text;
}

export function optionalText(value, field, { max = 512 } = {}) {
  if (value === null || value === undefined || value === "") return null;
  return requiredText(value, field, { max });
}

export function walletAddress(value, field = "walletAddress") {
  const address = requiredText(value, field, { max: 42 }).toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(address)) throw new PersistenceValidationError(`${field} must be a valid EVM address.`, field);
  return address;
}

export function chainId(value, field = "chainId") {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new PersistenceValidationError(`${field} must be a positive integer.`, field);
  return parsed;
}

export function nonNegativeBigInt(value, field) {
  try {
    const parsed = BigInt(String(value));
    if (parsed < 0n) throw new Error();
    return parsed.toString();
  } catch {
    throw new PersistenceValidationError(`${field} must be a non-negative integer.`, field);
  }
}

export function positiveBigInt(value, field) {
  const parsed = nonNegativeBigInt(value, field);
  if (parsed === "0") throw new PersistenceValidationError(`${field} must be greater than zero.`, field);
  return parsed;
}

export function enumValue(value, field, values) {
  if (!values.includes(value)) throw new PersistenceValidationError(`${field} must be one of: ${values.join(", ")}.`, field);
  return value;
}

export function normalizeJson(value, fallback = {}) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "object" || Array.isArray(value)) throw new PersistenceValidationError("JSON metadata must be an object.");
  return value;
}
