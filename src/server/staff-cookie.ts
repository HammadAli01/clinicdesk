// The staff sign-in cookie: its name, and a tiny reader for a raw Cookie header.
// The value is a random session token (see services/staff.ts), never a password.

export const STAFF_COOKIE = "staff_session";

/** The value of cookie `name` in a raw `Cookie:` header, or undefined. */
export function readCookie(header: string | null, name: string): string | undefined {
  for (const part of (header ?? "").split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq) === name) return part.slice(eq + 1);
  }
  return undefined;
}
