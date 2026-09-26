// Staff sign-in / sign-out handlers (src/server/admin-auth.ts). Built with an
// explicit token, so the test doesn't depend on .env.test's ADMIN_TOKEN.
import { describe, expect, it } from "vitest";
import { createAdminAuthHandlers } from "@/server/admin-auth";

const TOKEN = "test-admin-token-at-least-16";
const BASE = "http://localhost:3000";

function formPost(path: string, fields: Record<string, string>) {
  return new Request(`${BASE}${path}`, { method: "POST", body: new URLSearchParams(fields) });
}

describe("POST /api/admin/login", () => {
  const { login } = createAdminAuthHandlers({ adminToken: TOKEN, secureCookies: false });

  it("with the right token: sets an httpOnly admin_token cookie and redirects to /admin", async () => {
    const res = await login(formPost("/api/admin/login", { token: TOKEN }));

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${BASE}/admin`);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`admin_token=${TOKEN}`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/Max-Age=43200/);
    expect(cookie).not.toMatch(/Secure/i);
  });

  it("with a wrong token: no cookie, back to the login page with an error", async () => {
    const res = await login(formPost("/api/admin/login", { token: "not-the-token-at-all" }));

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${BASE}/admin/login?error=1`);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("with no form body: no cookie, back to the login page with an error", async () => {
    const res = await login(new Request(`${BASE}/api/admin/login`, { method: "POST" }));

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${BASE}/admin/login?error=1`);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("marks the cookie Secure when secureCookies is on (production)", async () => {
    const prod = createAdminAuthHandlers({ adminToken: TOKEN, secureCookies: true });

    const res = await prod.login(formPost("/api/admin/login", { token: TOKEN }));

    expect(res.headers.get("set-cookie") ?? "").toMatch(/Secure/i);
  });
});

describe("POST /api/admin/logout", () => {
  it("expires the admin_token cookie and redirects to the login page", async () => {
    const { logout } = createAdminAuthHandlers({ adminToken: TOKEN, secureCookies: false });

    const res = await logout(new Request(`${BASE}/api/admin/logout`, { method: "POST" }));

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${BASE}/admin/login`);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^admin_token=;/);
    expect(cookie).toMatch(/Max-Age=0/);
  });
});
