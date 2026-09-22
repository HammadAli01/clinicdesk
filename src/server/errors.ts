// Expected failures ("slot taken", "not found") are different from bugs.
// Give them their own error class, so each adapter can translate them:
// tRPC into a 409, MCP into a message the AI can read and recover from.

export type DomainErrorCode = "NOT_FOUND" | "CONFLICT" | "BAD_REQUEST" | "FORBIDDEN";

export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}

// Postgres error codes: 23505 = unique violation, 23P01 = exclusion violation.
// Drizzle may wrap the driver error, so check .cause too.
export function pgErrorCode(e: unknown): string | undefined {
  if (typeof e !== "object" || e === null) return undefined;

  const directCode = "code" in e ? e.code : undefined;
  if (typeof directCode === "string") return directCode;

  if (!("cause" in e)) return undefined;
  const cause = e.cause;
  if (typeof cause !== "object" || cause === null) return undefined;
  if (!("code" in cause)) return undefined;

  const causeCode = cause.code;
  return typeof causeCode === "string" ? causeCode : undefined;
}
