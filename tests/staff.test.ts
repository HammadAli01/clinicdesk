// Staff accounts and sessions (src/server/services/staff.ts + passwords.ts),
// against the real test database.
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { staffSessions, staffUsers } from "@/server/db/schema";
import { hashPassword, verifyPassword } from "@/server/passwords";
import {
  createStaffUser,
  getStaffBySession,
  SESSION_HOURS,
  signIn,
  signOut,
} from "@/server/services/staff";

const ALI = { email: "Ali@Clinic.test", password: "correct horse battery" };

describe("passwords", () => {
  it("verifies the right password, rejects a wrong one, and salts every hash", async () => {
    const a = await hashPassword("correct horse battery");
    const b = await hashPassword("correct horse battery");

    expect(a).not.toBe(b); // different random salts
    expect(a).not.toContain("correct horse battery");
    expect(await verifyPassword("correct horse battery", a)).toBe(true);
    expect(await verifyPassword("wrong horse battery", a)).toBe(false);
    expect(await verifyPassword("anything", "not-a-valid-hash")).toBe(false);
  });
});

describe("createStaffUser", () => {
  it("stores a lower-cased email and a hash (never the password), and is idempotent", async () => {
    const first = await createStaffUser(db, ALI);
    const second = await createStaffUser(db, { ...ALI, email: "ali@clinic.test" });

    expect(first?.email).toBe("ali@clinic.test");
    expect(second).toBeNull(); // same address, different case: already exists
    const rows = await db.select().from(staffUsers);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.passwordHash).toMatch(/^scrypt\$/);
  });

  it("rejects a password shorter than 12 characters", async () => {
    await expect(createStaffUser(db, { email: "b@clinic.test", password: "short" })).rejects.toThrow();
    expect(await db.select().from(staffUsers)).toHaveLength(0);
  });
});

describe("signIn / getStaffBySession / signOut", () => {
  it("signs in with the right password (any email case) and the token finds the staff member", async () => {
    await createStaffUser(db, ALI);

    const session = await signIn(db, { email: "ALI@clinic.test", password: ALI.password });

    expect(session).not.toBeNull();
    const staff = await getStaffBySession(db, session?.token ?? "");
    expect(staff?.email).toBe("ali@clinic.test");
    // The database holds a hash of the token, not the token itself.
    const [row] = await db.select().from(staffSessions);
    expect(row?.id).not.toBe(session?.token);
    expect(row?.id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns null for a wrong password and for an unknown email, creating no session", async () => {
    await createStaffUser(db, ALI);

    expect(await signIn(db, { email: ALI.email, password: "wrong password here" })).toBeNull();
    expect(await signIn(db, { email: "nobody@clinic.test", password: ALI.password })).toBeNull();
    expect(await db.select().from(staffSessions)).toHaveLength(0);
  });

  it("an expired session no longer finds anyone", async () => {
    await createStaffUser(db, ALI);
    const session = await signIn(db, { ...ALI, now: new Date() });
    const later = new Date(Date.now() + (SESSION_HOURS * 60 + 1) * 60_000);

    expect(await getStaffBySession(db, session?.token ?? "", later)).toBeNull();
  });

  it("signOut deletes the session; the token stops working", async () => {
    await createStaffUser(db, ALI);
    const session = await signIn(db, ALI);
    const token = session?.token ?? "";

    await signOut(db, token);

    expect(await getStaffBySession(db, token)).toBeNull();
    expect(await db.select().from(staffSessions)).toHaveLength(0);
  });

  it("deleting a staff user deletes their sessions (ON DELETE CASCADE)", async () => {
    const user = await createStaffUser(db, ALI);
    await signIn(db, ALI);

    await db.delete(staffUsers).where(eq(staffUsers.id, user?.id ?? ""));

    expect(await db.select().from(staffSessions)).toHaveLength(0);
  });
});
