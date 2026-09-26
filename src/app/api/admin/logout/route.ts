// POST /api/admin/logout: the "Sign out" button posts here. Logic in src/server/admin-auth.ts.
import { env } from "@/env";
import { createAdminAuthHandlers } from "@/server/admin-auth";

export const runtime = "nodejs";

export const POST = createAdminAuthHandlers({
  adminToken: env.ADMIN_TOKEN,
  secureCookies: env.NODE_ENV === "production",
}).logout;
