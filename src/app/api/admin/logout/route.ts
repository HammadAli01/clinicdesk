// POST /api/admin/logout: the "Sign out" button posts here. Logic in src/server/admin-auth.ts.
import { env } from "@/env";
import { db } from "@/server/db";
import { createAdminAuthHandlers } from "@/server/admin-auth";

export const runtime = "nodejs"; // node:crypto (scrypt, sha256)

export const POST = createAdminAuthHandlers({
  db,
  secureCookies: env.NODE_ENV === "production",
}).logout;
