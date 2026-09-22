import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { env } from "@/env";
import { GOOGLE_SCOPE, REDIRECT_URI } from "@/server/integrations/google";

export async function GET() {
  // Next.js 16: cookies() is async -- must be awaited before use.
  const jar = await cookies();
  if (jar.get("admin_token")?.value !== env.ADMIN_TOKEN) {
    return new Response("Unauthorized", { status: 401 });
  }

  const state = randomBytes(16).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  const cookieOptions = {
    httpOnly: true, // JS can't read it
    secure: env.NODE_ENV === "production", // HTTPS only in prod
    sameSite: "lax" as const, // sent on the redirect back from Google
    maxAge: 600, // 10 minutes to finish the flow
    path: "/api/oauth/google",
  };
  jar.set("g_state", state, cookieOptions);
  jar.set("g_verifier", verifier, cookieOptions);

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: GOOGLE_SCOPE,
    access_type: "offline", // ask for a refresh token
    prompt: "consent", // force consent so Google actually returns one
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return Response.redirect(url, 302);
}
