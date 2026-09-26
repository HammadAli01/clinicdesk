// Business rules for staff accounts and sign-in sessions.
// Adapters (the /api/admin/* routes, tRPC's context) call these and never touch
// the staff tables directly. `db` is always the first argument (dependency injection).
//
// Session design: the browser cookie holds a random 32-byte token. The database
// stores only sha256(token) as the session id, so someone who reads the database
// still can't produce a working cookie.
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/server/db";
import { staffSessions, staffUsers } from "@/server/db/schema";
import { hashPassword, verifyPassword } from "@/server/passwords";

export const SESSION_HOURS = 12;

export const StaffCredentials = z.object({
  email: z.email().transform((e) => e.toLowerCase()), // one canonical form per address
  password: z.string().min(12, "Password must be at least 12 characters"),
});
export type StaffCredentials = z.input<typeof StaffCredentials>;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// Verified against when the email doesn't exist, so "unknown email" takes as long
// as "wrong password" and response timing doesn't reveal which emails are staff.
const dummyHash = hashPassword("not-a-real-password-just-for-timing");

/**
 * Create a staff user, or do nothing if that email already exists (idempotent,
 * so the seed can run many times). Returns the new row, or null if it existed.
 */
export async function createStaffUser(db: Db, input: StaffCredentials) {
  const { email, password } = StaffCredentials.parse(input);
  const [row] = await db
    .insert(staffUsers)
    .values({ email, passwordHash: await hashPassword(password) })
    .onConflictDoNothing({ target: staffUsers.email })
    .returning({ id: staffUsers.id, email: staffUsers.email });
  return row ?? null;
}

/**
 * Check an email + password. On success, create a session and return its token
 * (for the cookie) and expiry. On any failure return null: the caller shows one
 * generic "wrong email or password" message either way.
 */
export async function signIn(
  db: Db,
  input: { email: string; password: string; now?: Date },
): Promise<{ token: string; expiresAt: Date } | null> {
  const email = input.email.trim().toLowerCase();
  const user = await db.query.staffUsers.findFirst({ where: eq(staffUsers.email, email) });

  const ok = await verifyPassword(input.password, user?.passwordHash ?? (await dummyHash));
  if (!user || !ok) return null;

  const token = randomBytes(32).toString("base64url");
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + SESSION_HOURS * 60 * 60_000);
  await db.insert(staffSessions).values({ id: sha256(token), staffUserId: user.id, expiresAt });
  return { token, expiresAt };
}

/** The staff member a cookie token belongs to, or null if unknown or expired. */
export async function getStaffBySession(db: Db, token: string, now = new Date()) {
  const [row] = await db
    .select({ id: staffUsers.id, email: staffUsers.email })
    .from(staffSessions)
    .innerJoin(staffUsers, eq(staffSessions.staffUserId, staffUsers.id))
    .where(and(eq(staffSessions.id, sha256(token)), gt(staffSessions.expiresAt, now)));
  return row ?? null;
}

/** End a session (sign out). Safe to call with an unknown token. */
export async function signOut(db: Db, token: string): Promise<void> {
  await db.delete(staffSessions).where(eq(staffSessions.id, sha256(token)));
}
