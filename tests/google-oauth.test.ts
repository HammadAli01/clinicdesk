// These tests use the REAL test database (see tests/setup.ts, which truncates
// oauth_accounts before every test) -- we never mock Drizzle. The only thing
// we stub is the vendor HTTP call: Google's token endpoint, reached through
// the global `fetch`. That's a legitimate boundary to stub (we don't control
// Google's server); mocking our own database would just test the mock.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { db } from "@/server/db";
import { oauthAccounts } from "@/server/db/schema";
import {
  GOOGLE_SCOPE,
  GoogleAuthError,
  getGoogleAccessToken,
  googleFetch,
} from "@/server/integrations/google";

const originalFetch = globalThis.fetch;
let fetchMock: Mock<typeof fetch>;

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  globalThis.fetch = fetchMock;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Seeds an oauth_accounts row whose access token is already expired. */
async function insertExpiredAccount() {
  const [row] = await db
    .insert(oauthAccounts)
    .values({
      provider: "google",
      accessToken: "old-access-token",
      refreshToken: "old-refresh-token",
      expiresAt: new Date(0),
      scope: GOOGLE_SCOPE,
    })
    .returning();
  if (!row) throw new Error("seed insert did not return a row");
  return row;
}

/** Seeds an oauth_accounts row whose access token is still valid for an hour. */
async function insertValidAccount() {
  const [row] = await db
    .insert(oauthAccounts)
    .values({
      provider: "google",
      accessToken: "still-valid-token",
      refreshToken: "unused-refresh-token",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      scope: GOOGLE_SCOPE,
    })
    .returning();
  if (!row) throw new Error("seed insert did not return a row");
  return row;
}

async function findAccount() {
  return db.query.oauthAccounts.findFirst({ where: eq(oauthAccounts.provider, "google") });
}

describe("getGoogleAccessToken", () => {
  it("keeps the old refresh token when Google's refresh response omits one", async () => {
    await insertExpiredAccount();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        access_token: "new-access-token",
        expires_in: 3600,
        scope: GOOGLE_SCOPE,
        token_type: "Bearer",
        // Deliberately no refresh_token, exactly like a real Google refresh response.
      }),
    );

    const token = await getGoogleAccessToken(db);

    expect(token).toBe("new-access-token");
    const row = await findAccount();
    expect(row?.accessToken).toBe("new-access-token");
    expect(row?.refreshToken).toBe("old-refresh-token"); // unchanged
  });

  it("saves a rotated refresh token when Google sends a new one", async () => {
    await insertExpiredAccount();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        expires_in: 3600,
        scope: GOOGLE_SCOPE,
        token_type: "Bearer",
      }),
    );

    await getGoogleAccessToken(db);

    const row = await findAccount();
    expect(row?.refreshToken).toBe("new-refresh-token");
  });

  it("disconnects the account instead of retrying when Google returns invalid_grant", async () => {
    await insertExpiredAccount();
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { error: "invalid_grant" }));

    let caught: unknown;
    try {
      await getGoogleAccessToken(db);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(GoogleAuthError);
    expect(caught).toMatchObject({ oauthError: "invalid_grant" });

    const row = await findAccount();
    expect(row).toBeUndefined(); // disconnected, not left around to be retried
  });

  it("single-flights concurrent refreshes into exactly one HTTP call", async () => {
    await insertExpiredAccount();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        access_token: "single-flight-token",
        expires_in: 3600,
        scope: GOOGLE_SCOPE,
        token_type: "Bearer",
      }),
    );

    const [a, b, c] = await Promise.all([
      getGoogleAccessToken(db),
      getGoogleAccessToken(db),
      getGoogleAccessToken(db),
    ]);

    expect(a).toBe("single-flight-token");
    expect(b).toBe("single-flight-token");
    expect(c).toBe("single-flight-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never touches the network when the stored token is still valid", async () => {
    await insertValidAccount();

    const token = await getGoogleAccessToken(db);

    expect(token).toBe("still-valid-token");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("googleFetch", () => {
  // Real timers on purpose: a single 429 retry sleeps ~0.5-0.75s (attempt 0 of
  // the backoff schedule in google.ts), which is fast enough not to need fake
  // timers, and fake timers would have to be carefully interleaved with the
  // real Postgres round-trips this test also makes.
  it("backs off and retries on 429, then returns the successful response", async () => {
    await insertValidAccount();
    fetchMock
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const res = await googleFetch(db, "/calendar/v3/calendars/primary/events");

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
