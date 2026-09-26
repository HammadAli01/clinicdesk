// Staff sign-in / sign-out handlers (src/server/admin-auth.ts) against the real
// test database: a real staff account, real sessions, real cookies.
import { describe, expect, it } from "vitest";
import { createAdminAuthHandlers } from "@/server/admin-auth";
import { db } from "@/server/db";
import { staffSessions } from "@/server/db/schema";
import { createStaffUser, getStaffBySession } from "@/server/services/staff";

const BASE = "http://localhost:3000";
const STAFF = { email: "staff@clinic.test", password: "a long enough password" };
const { login, logout } = createAdminAuthHandlers({ db, secureCookies: false });

function formPost(path: string, fields: Record<string, string>, cookie?: string) {
  const headers = new Headers(cookie ? { cookie } : {});
  return new Request(`${BASE}${path}`, {
    method: "POST",
    headers,
    body: new URLSearchParams(fields),
  });
}

/** The value of staff_session in a Set-Cookie header, or undefined. */
const sessionFrom = (setCookie: string | null) =>
  /^staff_session=([^;]*)/.exec(setCookie ?? "")?.[1];

describe("POST /api/admin/login", () => {
  it("with the right email + password: sets an httpOnly session cookie and redirects to /admin", async () => {
    await createStaffUser(db, STAFF);

    const res = await login(formPost("/api/admin/login", STAFF));

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${BASE}/admin`);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toMatch(/Max-Age=43200/);
    expect(cookie).not.toMatch(/Secure/i);
    expect(cookie).not.toContain(STAFF.password);
    // The cookie's token is a live session for this staff member.
    const staff = await getStaffBySession(db, sessionFrom(cookie) ?? "");
    expect(staff?.email).toBe(STAFF.email);
  });

  it("with a wrong password: no cookie, no session, back to login with an error", async () => {
    await createStaffUser(db, STAFF);

    const res = await login(formPost("/api/admin/login", { ...STAFF, password: "wrong password!!" }));

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${BASE}/admin/login?error=1`);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await db.select().from(staffSessions)).toHaveLength(0);
  });

  it("with no form body: back to login with an error", async () => {
    const res = await login(new Request(`${BASE}/api/admin/login`, { method: "POST" }));

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${BASE}/admin/login?error=1`);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("marks the cookie Secure when secureCookies is on (production)", async () => {
    await createStaffUser(db, STAFF);
    const prod = createAdminAuthHandlers({ db, secureCookies: true });

    const res = await prod.login(formPost("/api/admin/login", STAFF));

    expect(res.headers.get("set-cookie") ?? "").toMatch(/Secure/i);
  });
});

describe("POST /api/admin/logout", () => {
  it("ends the session on the server and expires the cookie", async () => {
    await createStaffUser(db, STAFF);
    const signedIn = await login(formPost("/api/admin/login", STAFF));
    const token = sessionFrom(signedIn.headers.get("set-cookie")) ?? "";

    const res = await logout(formPost("/api/admin/logout", {}, `staff_session=${token}`));

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${BASE}/admin/login`);
    expect(res.headers.get("set-cookie") ?? "").toMatch(/^staff_session=;.*Max-Age=0/);
    expect(await getStaffBySession(db, token)).toBeNull();
    expect(await db.select().from(staffSessions)).toHaveLength(0);
  });
});
