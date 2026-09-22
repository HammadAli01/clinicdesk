import { eq } from "drizzle-orm";
import { z } from "zod";
import { env } from "@/env";
import type { Db } from "@/server/db";
import { oauthAccounts } from "@/server/db/schema";

export const GOOGLE_SCOPE = "https://www.googleapis.com/auth/calendar.events";
export const REDIRECT_URI = `${env.APP_URL}/api/oauth/google/callback`;

const TokenResponse = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  refresh_token: z.string().optional(), // only on first consent -- NOT on refresh
  scope: z.string(),
  token_type: z.literal("Bearer"),
});
type TokenResponse = z.infer<typeof TokenResponse>;

export class GoogleAuthError extends Error {
  readonly oauthError: string;
  constructor(oauthError: string) {
    super(`Google OAuth error: ${oauthError}`);
    this.name = "GoogleAuthError";
    this.oauthError = oauthError;
  }
}

async function postToken(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      ...params,
    }),
  });
  const json: unknown = await res.json();
  if (!res.ok) {
    // Google's error body is untrusted input too: parse it, don't assume its shape.
    const parsed = z.object({ error: z.string() }).safeParse(json);
    throw new GoogleAuthError(parsed.success ? parsed.data.error : `http_${res.status}`);
  }
  return TokenResponse.parse(json);
}

export function exchangeCode(code: string, codeVerifier: string) {
  return postToken({
    grant_type: "authorization_code",
    code,
    code_verifier: codeVerifier,
    redirect_uri: REDIRECT_URI,
  });
}

export async function saveGoogleTokens(
  db: Db,
  t: TokenResponse & { refresh_token: string },
) {
  const values = {
    provider: "google" as const,
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt: new Date(Date.now() + t.expires_in * 1000),
    scope: t.scope,
  };
  await db.insert(oauthAccounts).values(values).onConflictDoUpdate({
    target: oauthAccounts.provider,
    set: values,
  });
}

// ---- Getting a valid access token (the part that breaks) ----

// If 5 calendar calls start at once with an expired token, we want ONE refresh,
// not five. This "single-flight" promise handles that within one process.
let refreshInFlight: Promise<string> | null = null;

export async function getGoogleAccessToken(db: Db): Promise<string | null> {
  const account = await db.query.oauthAccounts.findFirst({
    where: eq(oauthAccounts.provider, "google"),
  });
  if (!account) return null; // clinic hasn't connected Google

  // Refresh 60s early, so a token doesn't expire mid-request.
  if (account.expiresAt.getTime() - Date.now() > 60_000) return account.accessToken;

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
    throw e;
  }
}

export async function markAccessTokenExpired(db: Db) {
  await db.update(oauthAccounts).set({ expiresAt: new Date(0) }).where(eq(oauthAccounts.provider, "google"));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** fetch() for Google APIs: adds the token, refreshes once on 401, backs off on 429/5xx. */
export async function googleFetch(db: Db, path: string, init: RequestInit = {}): Promise<Response> {
  let refreshedAfter401 = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    const token = await getGoogleAccessToken(db);
    if (!token) throw new Error("Google Calendar is not connected");

    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("Content-Type", "application/json");
    const res = await fetch(`https://www.googleapis.com${path}`, { ...init, headers });

    if (res.status === 401 && !refreshedAfter401) {
      // Token was revoked early or clocks disagree: force one refresh and retry.
      refreshedAfter401 = true;
      await markAccessTokenExpired(db);
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      // Exponential backoff with jitter: ~0.5s, 1s, 2s (+ random)
      await sleep(2 ** attempt * 500 + Math.random() * 250);
      continue;
    }
    return res;
  }
  throw new Error(`Google API ${path} failed after retries`);
}
