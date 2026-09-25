// Expected failures ("slot taken", "not found") are different from bugs.
// Give them their own error class, so each adapter can translate them:
// tRPC into a 409, MCP into a message the AI can read and recover from.

// A UNION of string LITERAL types: the code can only be one of these four
// strings, and a typo like "NOT_FOUNd" is a compile error. (This is the
// idiomatic alternative to a TypeScript `enum`.) The names deliberately match
// tRPC's error codes, so init.ts can pass `code` straight through.
export type DomainErrorCode = "NOT_FOUND" | "CONFLICT" | "BAD_REQUEST" | "FORBIDDEN";

/**
 * An EXPECTED business failure ("slot taken", "not found"), safe to show the
 * caller. Services throw it; adapters translate it. Anything that is NOT a
 * DomainError is treated as a bug and its message is hidden.
 */
export class DomainError extends Error {
  // `readonly`: can be set in the constructor, never changed afterwards.
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string) {
    super(message); // call the parent (Error) constructor first; it sets `.message`
    this.name = "DomainError";
    this.code = code;
  }
}

// Postgres error codes: 23505 = unique violation, 23P01 = exclusion violation.
// Drizzle may wrap the driver error, so check .cause too.
//
// Technique: NARROWING `unknown` step by step, with no `as` cast. `unknown`
// means "could be anything", so TypeScript makes us prove its shape first:
// `typeof` checks, a null check, then the `in` operator ("does it have a
// `code` property?"). After each check the type gets more specific.
export function pgErrorCode(e: unknown): string | undefined {
  // typeof null === "object" in JS (a famous quirk), hence the extra null check.
  if (typeof e !== "object" || e === null) return undefined;

  const directCode = "code" in e ? e.code : undefined; // `in` narrows e to `object & { code: unknown }`
  if (typeof directCode === "string") return directCode;

  if (!("cause" in e)) return undefined;
  const cause = e.cause;
  if (typeof cause !== "object" || cause === null) return undefined;
  if (!("code" in cause)) return undefined;

  const causeCode = cause.code;
  return typeof causeCode === "string" ? causeCode : undefined;
}
