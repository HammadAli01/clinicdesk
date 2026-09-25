// Google OAuth + Calendar API client. Everything that talks to Google over HTTP lives here, so
// token handling and retry policy exist in exactly ONE place.
//
// The three jobs of this file:
//   1. Exchange / refresh tokens at Google's token endpoint   (postToken, exchangeCode)
//   2. Store tokens and hand out a VALID access token          (saveGoogleTokens, getGoogleAccessToken)
//   3. Call Google APIs with that token, retrying sensibly     (googleFetch)
//
// Vocabulary (full explanation in docs/07-oauth-and-tokens.md):
//   access token  -- short-lived (~1h) key sent as `Authorization: Bearer <token>` on API calls.
//   refresh token -- long-lived key used ONLY to get new access tokens. Guard it like a password.
//   invalid_grant -- Google's "that refresh token is dead" error. Means: disconnect, don't retry.

import { eq } from "drizzle-orm";
import { z } from "zod";
import { env } from "@/env";
import type { Db } from "@/server/db";
import { oauthAccounts } from "@/server/db/schema";

// The permission we ask for. `calendar.events` = read/write events only -- deliberately NOT the
// broader `calendar` scope (which could also delete whole calendars). Least privilege.
export const GOOGLE_SCOPE = "https://www.googleapis.com/auth/calendar.events";
// Google refuses the flow unless this matches a redirect URI registered in Google Cloud Console
// character-for-character (scheme, host, port, path, trailing slash).
export const REDIRECT_URI = `${env.APP_URL}/api/oauth/google/callback`;

// Zod schema for Google's token response. Google's reply is third-party input, so we check its
// shape at runtime instead of trusting it (CLAUDE.md: "Zod at every boundary").
const TokenResponse = z.object({
  access_token: z.string(),
  expires_in: z.number(), // SECONDS until the access token expires (usually 3599)
  refresh_token: z.string().optional(), // only on first consent -- NOT on refresh
  scope: z.string(),
  token_type: z.literal("Bearer"),
});
// Same name used for a value (the schema) and a type (what it parses to). TypeScript keeps
// values and types in separate namespaces, so this is legal and a common Zod idiom.
type TokenResponse = z.infer<typeof TokenResponse>;

// A custom error class so callers can tell "Google rejected our credentials" apart from a
// network error with `instanceof GoogleAuthError`, and read the OAuth error code.
export class GoogleAuthError extends Error {
  readonly oauthError: string; // e.g. "invalid_grant", "invalid_client"
  constructor(oauthError: string) {
    super(`Google OAuth error: ${oauthError}`);
    this.name = "GoogleAuthError";
    this.oauthError = oauthError;
  }
}

// The one function that POSTs to Google's token endpoint. Used for BOTH grant types:
// "authorization_code" (first connect) and "refresh_token" (every hour afterwards).
async function postToken(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    // OAuth 2.0 token endpoints take form-encoded bodies (a=1&b=2), not JSON.
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET, // server-side only; never sent to a browser
      ...params, // spread: merges in the grant-specific fields
    }),
  });
  // `unknown`, not `any`: forces us to validate before using it.
  const json: unknown = await res.json();
  if (!res.ok) {
    // Google's error body is untrusted input too: parse it, don't assume its shape.
    const parsed = z.object({ error: z.string() }).safeParse(json);
    throw new GoogleAuthError(parsed.success ? parsed.data.error : `http_${res.status}`);
  }
  // .parse throws a readable ZodError if Google ever changes the response shape.
  return TokenResponse.parse(json);
}

/** Step 2 of the flow: trade the one-time authorization code (plus PKCE verifier) for tokens. */
export function exchangeCode(code: string, codeVerifier: string) {
  return postToken({
    grant_type: "authorization_code",
    code,
    code_verifier: codeVerifier, // PKCE: Google hashes this and compares to the challenge from /start
    redirect_uri: REDIRECT_URI, // must be the same value used in /start
  });
}

// `TokenResponse & { refresh_token: string }` is an INTERSECTION type: "a TokenResponse, but
// refresh_token is required". The type system makes it impossible to save a connection
// without a refresh token -- the callback has to prove it has one first.
export async function saveGoogleTokens(
  db: Db,
  t: TokenResponse & { refresh_token: string },
) {
  const values = {
    provider: "google" as const,
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    // Convert "expires in N seconds" to an absolute time we can compare against later.
    expiresAt: new Date(Date.now() + t.expires_in * 1000),
    scope: t.scope,
  };
  // UPSERT: insert, or if a "google" row already exists (unique `provider` column), update it.
  // Reconnecting Google therefore replaces the old tokens instead of adding a second row.
  await db.insert(oauthAccounts).values(values).onConflictDoUpdate({
    target: oauthAccounts.provider,
    set: values,
  });
}

// ---- Getting a valid access token (the part that breaks) ----

// If 5 calendar calls start at once with an expired token, we want ONE refresh,
// not five. This "single-flight" promise handles that within one process.
// (Per-process only: two server instances could still both refresh. See docs/07 "gaps".)
let refreshInFlight: Promise<string> | null = null;

export async function getGoogleAccessToken(db: Db): Promise<string | null> {
  const account = await db.query.oauthAccounts.findFirst({
    where: eq(oauthAccounts.provider, "google"),
  });
  if (!account) return null; // clinic hasn't connected Google

  // Refresh 60s early, so a token doesn't expire mid-request.
  if (account.expiresAt.getTime() - Date.now() > 60_000) return account.accessToken;

  // `??=` (nullish assignment): assign ONLY if refreshInFlight is null/undefined. The first
  // caller starts the refresh; callers arriving while it's running get the same promise.
  // There is no `await` between the check and the assignment, so no other call can sneak in.
  // `.finally` clears the slot when the refresh settles (success OR failure).
  refreshInFlight ??= refreshAccessToken(db, account.refreshToken).finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function refreshAccessToken(db: Db, refreshToken: string): Promise<string> {
  try {
    const t = await postToken({ grant_type: "refresh_token", refresh_token: refreshToken });
    await db
      .update(oauthAccounts)
      .set({
        accessToken: t.access_token,
        expiresAt: new Date(Date.now() + t.expires_in * 1000),
        // Keep the old refresh token unless Google sent a new one.
        // Conditional spread: `...(cond ? {x} : {})` adds the key only when cond is true.
        // Writing `refreshToken: t.refresh_token` would store undefined on most refreshes
        // (Google usually omits it) and kill the integration an hour later.
        ...(t.refresh_token ? { refreshToken: t.refresh_token } : {}),
      })
      .where(eq(oauthAccounts.provider, "google"));
    return t.access_token;
  } catch (e) {
    if (e instanceof GoogleAuthError && e.oauthError === "invalid_grant") {
      // Refresh token revoked or expired: the user must reconnect.
      // Delete it so we stop hammering Google, and surface it to staff.
      await db.delete(oauthAccounts).where(eq(oauthAccounts.provider, "google"));
      console.error("Google connection lost (invalid_grant). Clinic must reconnect.");
    }
    // Re-throw either way: the caller must know this attempt failed.
    throw e;
  }
}

// Sets the expiry to 1970 so the next getGoogleAccessToken call is forced to refresh.
export async function markAccessTokenExpired(db: Db) {
  await db.update(oauthAccounts).set({ expiresAt: new Date(0) }).where(eq(oauthAccounts.provider, "google"));
}

// Promise-based pause: `await sleep(500)` waits half a second without blocking the event loop.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** fetch() for Google APIs: adds the token, refreshes once on 401, backs off on 429/5xx. */
export async function googleFetch(db: Db, path: string, init: RequestInit = {}): Promise<Response> {
  let refreshedAfter401 = false;
  // At most 4 attempts in total. A bounded loop: retries must always end.
  for (let attempt = 0; attempt < 4; attempt++) {
    const token = await getGoogleAccessToken(db);
    if (!token) throw new Error("Google Calendar is not connected");

    // Copy the caller's headers, then add ours (so callers can't forget the auth header).
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("Content-Type", "application/json");
    const res = await fetch(`https://www.googleapis.com${path}`, { ...init, headers });

    if (res.status === 401 && !refreshedAfter401) {
      // Token was revoked early or clocks disagree: force one refresh and retry.
      // ONCE only -- a token that keeps getting 401 would otherwise loop forever.
      refreshedAfter401 = true;
      await markAccessTokenExpired(db);
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      // Exponential backoff with jitter: ~0.5s, 1s, 2s (+ random)
      // `2 ** attempt` = 2 to the power of attempt. The random "jitter" spreads out retries
      // from many servers so they don't all hit Google again at the same millisecond.
      await sleep(2 ** attempt * 500 + Math.random() * 250);
      continue;
    }
    // Anything else (2xx, 404, 409, 400...) is a real answer -- hand it back to the caller.
    return res;
  }
  throw new Error(`Google API ${path} failed after retries`);
}
