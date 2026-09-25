// GET /api/oauth/google/callback -- STEP 2 of the OAuth 2.0 authorization code flow.
//
// Google sends the user's browser here after they click "Allow" (or "Cancel") on the consent
// screen. The URL looks like:
//   /api/oauth/google/callback?code=4/0Ab...&state=Xy9...
//
// Our job, in order:
//   1. Check `state` matches the cookie we set in /start      -> blocks CSRF / login-swap attacks.
//   2. Swap the one-time `code` (+ PKCE verifier) for tokens  -> a server-to-server POST to Google.
//   3. Save the tokens in the database.
//   4. Redirect back to the admin page with a status flag.
//
// Pattern: thin adapter. The real OAuth logic (HTTP to Google, Zod validation, saving) lives in
// src/server/integrations/google.ts; this file only reads the request and decides the response.

import { cookies } from "next/headers";
import { env } from "@/env";
import { db } from "@/server/db";
import { exchangeCode, saveGoogleTokens } from "@/server/integrations/google";

export async function GET(req: Request) {
  // `searchParams` is the parsed `?a=1&b=2` part of the URL.
  const params = new URL(req.url).searchParams;
  // Next.js 16: cookies() is async -- must be awaited before use.
  const jar = await cookies();
  const expectedState = jar.get("g_state")?.value;
  const verifier = jar.get("g_verifier")?.value;
  // Delete them straight away: each state/verifier pair is single-use. Even if something below
  // fails, a replayed callback URL can't reuse them.
  jar.delete("g_state");
  jar.delete("g_verifier");

  // A tiny helper (arrow function) so every "send them back to /admin" looks the same.
  // `new URL(path, base)` resolves the relative path against APP_URL.
  const back = (status: string) => Response.redirect(new URL(`/admin?google=${status}`, env.APP_URL), 302);

  if (params.get("error")) return back("denied"); // user clicked "Cancel"

  const code = params.get("code");
  const state = params.get("state");
  // Every value must be present AND the returned state must equal the one we stored.
  // If not, this callback wasn't the end of a flow this browser started -> refuse.
  if (!code || !state || !expectedState || !verifier || state !== expectedState) {
    return new Response("Invalid or expired OAuth state. Start again.", { status: 400 });
  }

  // Server-to-server: POST code + verifier + client secret to Google's token endpoint.
  // Throws GoogleAuthError if Google says no (e.g. the code was already used or expired).
  const tokens = await exchangeCode(code, verifier);
  if (!tokens.refresh_token) {
    // Happens if the user already granted access before and prompt=consent was missing.
    // Without a refresh token the integration would silently die in ~1 hour, so we refuse
    // loudly now with an instruction a human can follow.
    return new Response(
      "Google did not return a refresh token. Remove ClinicDesk at myaccount.google.com/permissions and connect again.",
      { status: 400 },
    );
  }
  // Spread syntax `{ ...tokens, refresh_token: ... }` copies every field and then overrides one.
  // Why bother? Inside this `if`-guarded branch TypeScript knows refresh_token is a `string`,
  // and re-stating it produces an object whose TYPE says so too -- which is what
  // saveGoogleTokens demands. No `!` or `as` cast needed.
  await saveGoogleTokens(db, { ...tokens, refresh_token: tokens.refresh_token });
  return back("connected");
}
