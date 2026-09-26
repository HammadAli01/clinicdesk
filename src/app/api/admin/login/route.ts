// POST /api/admin/login: the staff sign-in form posts here. Logic in src/server/admin-auth.ts.
import { env } from "@/env";
import { createAdminAuthHandlers } from "@/server/admin-auth";

export const runtime = "nodejs"; // node:crypto for the constant-time compare

export const POST = createAdminAuthHandlers({
  adminToken: env.ADMIN_TOKEN,
  secureCookies: env.NODE_ENV === "production",
}).login;
