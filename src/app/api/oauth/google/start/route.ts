// GET /api/oauth/google/start -- STEP 1 of the OAuth 2.0 "authorization code" flow.
//
// What this route does, in plain words:
//   A staff member clicks "Connect Google Calendar". We do NOT ask for their Google password.
//   Instead we send their browser to Google's own login/consent page, with a note saying
//   "ClinicDesk would like to manage calendar events". Google will later send the browser
//   back to our /callback route with a one-time code (see ../callback/route.ts).
//
// Pattern: "redirect to the provider". This route never talks to Google server-to-server;
// it only builds a URL and answers 302 (Found) so the BROWSER goes there.
//
// Two secrets are generated here and remembered in cookies so /callback can check them:
//   - `state`    -- anti-CSRF. Proves the callback belongs to a flow WE started.
//   - `verifier` -- PKCE. Proves the party redeeming the code is the one that asked for it.
// See docs/07-oauth-and-tokens.md for the full story and a sequence diagram.

// `node:` prefix = Node's built-in module (not an npm package). randomBytes gives
// cryptographically secure random bytes; createHash lets us compute SHA-256.
import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { env } from "@/env";
import { db } from "@/server/db";
import { GOOGLE_SCOPE, REDIRECT_URI } from "@/server/integrations/google";
import { getStaffBySession } from "@/server/services/staff";
import { STAFF_COOKIE } from "@/server/staff-cookie";

// In the Next.js App Router, exporting a function named after an HTTP method (GET, POST...)
// from a `route.ts` file makes it the handler for that method at this URL path.
export async function GET() {
  // Next.js 16: cookies() is async -- must be awaited before use.
  const jar = await cookies();
  // Only signed-in staff may start the flow. `?.` (optional chaining) means: if there is no
  // such cookie, `.value` is skipped and we get `undefined`.
  const token = jar.get(STAFF_COOKIE)?.value;
  const staff = token ? await getStaffBySession(db, token) : null;
  if (!staff) {
    return new Response("Unauthorized", { status: 401 });
  }

  // 16 random bytes = 128 bits: impossible to guess. "base64url" is base64 without the
  // characters (+ / =) that would need escaping in a URL.
  const state = randomBytes(16).toString("base64url");
  // PKCE: the verifier stays secret on our side; only its SHA-256 hash (the "challenge")
  // goes to Google now. At token-exchange time we reveal the verifier and Google checks
  // that hashing it gives the same challenge. A thief who only saw the URL can't do that.
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  const cookieOptions = {
    httpOnly: true, // JS can't read it
    secure: env.NODE_ENV === "production", // HTTPS only in prod
    // `as const` narrows the type from `string` to the literal "lax", which is what the
    // cookie API's type expects. (It's a type annotation, not a runtime cast.)
    sameSite: "lax" as const, // sent on the redirect back from Google
    maxAge: 600, // 10 minutes to finish the flow
    path: "/api/oauth/google", // browser only sends these cookies to our OAuth routes
  };
  jar.set("g_state", state, cookieOptions);
  jar.set("g_verifier", verifier, cookieOptions);

  // Build Google's authorization URL. URLSearchParams handles the percent-encoding for us.
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID, // which app is asking (public, not a secret)
    redirect_uri: REDIRECT_URI, // must EXACTLY match what's registered in Google Cloud Console
    response_type: "code", // "authorization code" flow: give me a code, not a token
    scope: GOOGLE_SCOPE, // what we're asking permission for (smallest scope that works)
    access_type: "offline", // ask for a refresh token
    prompt: "consent", // force consent so Google actually returns one
    state,
    code_challenge: challenge,
    code_challenge_method: "S256", // "the challenge is a SHA-256 hash" (vs. "plain")
  }).toString();
  // 302 = temporary redirect: the browser immediately navigates to Google.
  return Response.redirect(url, 302);
}
