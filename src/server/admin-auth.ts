// Staff sign-in / sign-out for /admin. Thin HTTP adapter over services/staff.ts,
// built as a factory so tests can pass the test db (same pattern as src/server/cron.ts).
//
// Sign in: email + password → signIn() creates a session → the random token goes
// into an httpOnly `staff_session` cookie. src/server/trpc/init.ts and
// /api/oauth/google/start look that token up on every request.
import { NextResponse } from "next/server";
import { z } from "zod";
import type { Db } from "@/server/db";
import { SESSION_HOURS, signIn, signOut } from "@/server/services/staff";
import { readCookie, STAFF_COOKIE } from "@/server/staff-cookie";

type Deps = {
  db: Db;
  /** true in production: the cookie is only ever sent over HTTPS. */
  secureCookies: boolean;
};

const LoginForm = z.object({ email: z.string().min(1), password: z.string().min(1) });

/**
 * Returns the handlers for POST /api/admin/login and POST /api/admin/logout.
 * Both answer with a 303 redirect, so a plain HTML <form method="post"> works
 * without any JavaScript, and "refresh" never re-submits the form.
 */
export function createAdminAuthHandlers({ db, secureCookies }: Deps) {
  const login = async (req: Request): Promise<Response> => {
    const loginPage = new URL("/admin/login?error=1", req.url);
    // formData() throws if the body isn't a form; treat that like wrong credentials.
    const form = await req.formData().catch(() => null);
    const parsed = LoginForm.safeParse(form ? Object.fromEntries(form) : {});
    if (!parsed.success) return NextResponse.redirect(loginPage, 303);

    const session = await signIn(db, parsed.data);
    if (!session) return NextResponse.redirect(loginPage, 303); // same answer for any failure

    const res = NextResponse.redirect(new URL("/admin", req.url), 303);
    res.cookies.set(STAFF_COOKIE, session.token, {
      httpOnly: true, // page JavaScript can't read it, so an XSS bug can't steal it
      secure: secureCookies,
      sameSite: "lax", // sent on normal navigation (incl. back from Google), not on cross-site POSTs
      path: "/",
      maxAge: SESSION_HOURS * 60 * 60,
    });
    return res;
  };

  const logout = async (req: Request): Promise<Response> => {
    const token = readCookie(req.headers.get("cookie"), STAFF_COOKIE);
    if (token) await signOut(db, token); // end it on the server, not just in this browser
    const res = NextResponse.redirect(new URL("/admin/login", req.url), 303);
    res.cookies.set(STAFF_COOKIE, "", { path: "/", maxAge: 0 }); // maxAge 0 = delete now
    return res;
  };

  return { login, logout };
}
