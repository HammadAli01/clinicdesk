import { cookies } from "next/headers";
import { env } from "@/env";
import { db } from "@/server/db";
import { exchangeCode, saveGoogleTokens } from "@/server/integrations/google";

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  // Next.js 16: cookies() is async -- must be awaited before use.
  const jar = await cookies();
  const expectedState = jar.get("g_state")?.value;
  const verifier = jar.get("g_verifier")?.value;
  jar.delete("g_state");
  jar.delete("g_verifier");

  const back = (status: string) => Response.redirect(new URL(`/admin?google=${status}`, env.APP_URL), 302);

  if (params.get("error")) return back("denied"); // user clicked "Cancel"

  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state || !expectedState || !verifier || state !== expectedState) {
    return new Response("Invalid or expired OAuth state. Start again.", { status: 400 });
  }

  const tokens = await exchangeCode(code, verifier);
  if (!tokens.refresh_token) {
    // Happens if the user already granted access before and prompt=consent was missing.
    return new Response(
      "Google did not return a refresh token. Remove ClinicDesk at myaccount.google.com/permissions and connect again.",
      { status: 400 },
    );
  }
  await saveGoogleTokens(db, { ...tokens, refresh_token: tokens.refresh_token });
  return back("connected");
}
