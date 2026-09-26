// Staff sign-in / sign-out for /admin. Thin HTTP adapter, built as a factory so
// tests can pass their own token (same pattern as src/server/cron.ts).
//
// Auth model (unchanged, demo-grade): staff type the shared ADMIN_TOKEN once;
// we store it in an httpOnly `admin_token` cookie, which src/server/trpc/init.ts
// and /api/oauth/google/start compare against env.ADMIN_TOKEN on every request.
// A real product would use per-user accounts and a session table instead.
import { NextResponse } from "next/server";
import { z } from "zod";
import { safeEqual } from "@/server/safe-equal";

export const ADMIN_COOKIE = "admin_token";
const TWELVE_HOURS = 60 * 60 * 12;

type Deps = {
  adminToken: string;
  /** true in production: the cookie is only ever sent over HTTPS. */
  secureCookies: boolean;
};

const LoginForm = z.object({ token: z.string().min(1) });

/**
 * Returns the handlers for POST /api/admin/login and POST /api/admin/logout.
 * Both answer with a 303 redirect, so a plain HTML <form method="post"> works
 * without any JavaScript, and "refresh" never re-submits the form.
 */
export function createAdminAuthHandlers({ adminToken, secureCookies }: Deps) {
  const login = async (req: Request): Promise<Response> => {
    const loginPage = new URL("/admin/login?error=1", req.url);
    // formData() throws if the body isn't a form; treat that like a wrong token.
    const form = await req.formData().catch(() => null);
    const parsed = LoginForm.safeParse(form ? Object.fromEntries(form) : {});
    if (!parsed.success || !safeEqual(parsed.data.token, adminToken)) {
      return NextResponse.redirect(loginPage, 303);
    }

    const res = NextResponse.redirect(new URL("/admin", req.url), 303);
    res.cookies.set(ADMIN_COOKIE, adminToken, {
      httpOnly: true, // page JavaScript can't read it, so an XSS bug can't steal it
      secure: secureCookies,
      sameSite: "lax", // sent on normal navigation (incl. back from Google), not on cross-site POSTs
      path: "/",
      maxAge: TWELVE_HOURS,
    });
    return res;
  };

  const logout = async (req: Request): Promise<Response> => {
    const res = NextResponse.redirect(new URL("/admin/login", req.url), 303);
    res.cookies.set(ADMIN_COOKIE, "", { path: "/", maxAge: 0 }); // maxAge 0 = delete now
    return res;
  };

  return { login, logout };
}
