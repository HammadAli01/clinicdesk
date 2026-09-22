# 07 · OAuth2, tokens, refresh and expiry

> *"Implemented at least one OAuth2 or webhook integration end to end, including the parts that
> break: token refresh, retries, replay, expiry."* — the job description

This chapter is that sentence, implemented. Every failure mode listed there has a line of code
and a test in this repo.

## What the flow is actually for

The clinic wants bookings in their Google Calendar. You must never ask them for their Google
password. OAuth2 lets the clinic owner tell Google: *"allow ClinicDesk to manage my calendar
events, and nothing else."* Google then hands **your server** a credential proving that grant.

| Term | What it is | Where it lives here |
|---|---|---|
| Client ID / secret | your app's identity with Google | `env.GOOGLE_CLIENT_ID` / `_SECRET`, server only |
| Scope | what you're asking for. Ask for the smallest one. | `calendar.events` — not full `calendar` |
| Redirect URI | where Google sends the user back; must match the registered value **exactly** | `${APP_URL}/api/oauth/google/callback` |
| Authorization code | a short-lived one-time code in the redirect | exchanged immediately, never stored |
| Access token | sent as `Authorization: Bearer …`; lives ~1 hour | `oauth_accounts.access_token` |
| Refresh token | long-lived; buys new access tokens without the user | `oauth_accounts.refresh_token` — **guard it like a password** |
| `state` | a random value you generate and check on return | `g_state` httpOnly cookie |
| PKCE verifier/challenge | proves the party finishing the flow is the one that started it | `g_verifier` httpOnly cookie |

## The flow, step by step

```
 1. Staff clicks "Connect Google Calendar"           → GET /api/oauth/google/start
 2. We check the admin cookie. Not admin → 401. No flow starts for a stranger.
 3. Generate `state` (16 random bytes) and a PKCE `verifier` (32 random bytes).
    challenge = base64url(sha256(verifier))
    Both stored in httpOnly, sameSite=lax, 10-minute cookies scoped to /api/oauth/google.
 4. 302 → accounts.google.com/o/oauth2/v2/auth
        ?client_id&redirect_uri&response_type=code&scope
        &access_type=offline      ← ask for a refresh token
        &prompt=consent           ← force consent so Google actually sends one
        &state&code_challenge&code_challenge_method=S256
 5. Staff approves. Google redirects → /api/oauth/google/callback?code=…&state=…
 6. We compare the returned `state` to the cookie. Mismatch/missing → 400, flow over.
 7. POST oauth2.googleapis.com/token with code + verifier + client secret.
 8. Response is parsed with Zod (it is third-party input) and stored in oauth_accounts,
    upserted on the unique `provider` column.
 9. Redirect → /admin?google=connected
```

### Why `state` exists

Without it: an attacker starts the OAuth flow with **their own** Google account, captures the
resulting `code`, and tricks a logged-in clinic admin into visiting
`/api/oauth/google/callback?code=<attacker's code>`. Your server dutifully exchanges it and now
the clinic's appointments are being written into the *attacker's* calendar. That is CSRF against
an OAuth callback, and one random value in an httpOnly cookie kills it.

### Why PKCE exists

The authorization code travels through the user's browser, where it can be intercepted (a
malicious extension, a logged referrer, a shared device). PKCE means the code alone is useless:
the token exchange also requires the `verifier`, which never left your server. It started as a
mobile/SPA protection, and there is no reason not to use it on a server too.

### Two Google-specific details that bite

`access_type=offline` is what asks for a refresh token at all. And `prompt=consent` forces the
consent screen *even if the user already approved* — because **Google only returns a refresh
token on first consent**. Reconnect without it and you get an access token, no refresh token, and
an integration that dies in an hour. That is why the callback has this:

```ts
if (!tokens.refresh_token) {
  return new Response(
    'Google did not return a refresh token. Remove ClinicDesk at ' +
    'myaccount.google.com/permissions and connect again.',
    { status: 400 },
  );
}
```

An explicit, actionable error beats storing `undefined` into a `NOT NULL` column at 2 a.m.

## Getting a valid token: where integrations actually die

```ts
export async function getGoogleAccessToken(db: Db): Promise<string | null> {
  const account = await db.query.oauthAccounts.findFirst({ where: eq(oauthAccounts.provider, 'google') });
  if (!account) return null;                                  // never connected

  if (account.expiresAt.getTime() - Date.now() > 60_000) {    // still good
    return account.accessToken;
  }

  refreshInFlight ??= refreshAccessToken(db, account.refreshToken)
    .finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}
```

Four deliberate decisions in eleven lines:

**1. Refresh 60 seconds early.** A token that expires *during* your request produces a 401 you
then have to recover from. Renewing a minute early costs nothing and removes a whole class of
flake. It also absorbs small clock skew between your server and Google's.

**2. Single-flight.** If five calendar syncs fire at once with an expired token, you want **one**
refresh, not five. `??=` assigns only if the slot is empty, and there is no `await` between the
check and the assignment, so within one Node process this is genuinely atomic.

> Test: *"single-flights concurrent refreshes into exactly one HTTP call"* — fires three
> concurrent calls and asserts the stubbed token endpoint was hit **once**.

**3. Keep the old refresh token unless Google sends a new one.**

```ts
...(t.refresh_token ? { refreshToken: t.refresh_token } : {}),
```

This is the single most important line in the file. A refresh response **usually has no
`refresh_token`**. Code that writes it unconditionally stores `undefined`, and the *next* refresh
— an hour later, with nobody watching — fails permanently. The spread is conditional so the
column keeps its value.

> This is also where an AI agent reliably goes wrong. It writes
> `refreshToken: t.refresh_token`, TypeScript objects because the field is `string | undefined`
> and the column is `NOT NULL`, and the agent "fixes" the type error with `as string` or `!`.
> The type system caught a real bug and the cast threw the catch away. Two tests pin this:
> *"keeps the old refresh token when Google's refresh response omits one"* and *"saves a rotated
> refresh token when Google sends a new one"*.

**4. `invalid_grant` means stop, not retry.**

```ts
if (e instanceof GoogleAuthError && e.oauthError === 'invalid_grant') {
  await db.delete(oauthAccounts).where(eq(oauthAccounts.provider, 'google'));
  console.error('Google connection lost (invalid_grant). Clinic must reconnect.');
}
```

`invalid_grant` means the refresh token is dead: the user revoked access, changed their password,
Google rotated it and you saved the wrong one, or — the classic — the OAuth consent screen is
still in **Testing** mode, where Google expires refresh tokens after **7 days**. Your integration
works all week and dies on day eight. Retrying cannot help; retrying in a loop gets you rate
limited and then blocked. Delete the connection, log loudly, and put "reconnect Google" in front
of a human.

> Test: *"disconnects the account instead of retrying when Google returns invalid_grant"* —
> asserts the call rejects **and** the row is gone.

## Calling the API: `googleFetch`

Every Google call goes through one wrapper, so the retry policy exists in exactly one place:

```ts
for (let attempt = 0; attempt < 4; attempt++) {
  const token = await getGoogleAccessToken(db);
  if (!token) throw new Error('Google Calendar is not connected');
  const res = await fetch(`https://www.googleapis.com${path}`, { ...init, headers });

  if (res.status === 401 && !refreshedAfter401) {
    refreshedAfter401 = true;            // exactly once, never a loop
    await markAccessTokenExpired(db);    // force the next iteration to refresh
    continue;
  }
  if ((res.status === 429 || res.status >= 500) && attempt < 3) {
    await sleep(2 ** attempt * 500 + Math.random() * 250);  // 0.5s, 1s, 2s + jitter
    continue;
  }
  return res;
}
```

- **401 → refresh once and retry.** Tokens can be revoked before they expire. Once, not in a
  loop: a permanently-401ing token would otherwise spin forever.
- **429/5xx → exponential backoff with jitter.** Exponential because the server needs increasing
  room; **jitter** because without it every one of your instances retries at the same
  millisecond and you DDoS the vendor in synchronised waves. The random term is not decoration.
- **Everything else is returned as-is.** A 404 is an answer, not a failure to retry.

> Test: *"backs off and retries on 429, then returns the successful response."*

## Idempotency on the write side

`syncToGoogleCalendar` chooses the Google event id itself, derived from our appointment id:

```ts
const eventId = appt.id.replaceAll('-', '');   // Google allows [a-v0-9]
...
if (!res.ok && res.status !== 409) throw new Error(...);   // 409 = already created. Fine.
```

If the webhook is delivered twice, the second insert gets **409 Conflict** from Google instead of
creating a duplicate event in the clinic's calendar. This is the general trick: *when a vendor
lets you supply the id, supplying it turns "create" into "create once".*

## Failure modes, and the defence for each

| What goes wrong | Why | Our defence |
|---|---|---|
| No refresh token on reconnect | Google only sends it on first consent | `access_type=offline` + `prompt=consent`, and an explicit error if it is still missing |
| Refresh response omits `refresh_token` | it normally does | conditional spread keeps the old one; two tests |
| `invalid_grant` at 3 a.m. | revoked / password changed / 7-day Testing-mode expiry | delete the connection, log, surface to staff. **Never retry.** |
| Token expires mid-request | clock skew, tight timing | refresh 60s early; retry once on 401 |
| Refresh stampede | N concurrent calls with an expired token | single-flight promise |
| Vendor rate limit | bursts | backoff **with jitter** |
| Tokens readable in a DB dump | stored as plain text | **known gap** — see below |
| Refresh race across instances | the single-flight guard is per-process | **known gap** — see below |

## Two gaps I did not close, and would have to in production

Being able to name what your code does *not* do is worth more in an interview than pretending it
is finished.

**1. Tokens are stored in plain text.** Anyone with a database dump has the clinic's calendar
access. In production: encrypt at rest with AES-256-GCM using a key from a secret manager (not
from `.env`), storing `{iv, ciphertext, authTag}` per token, and rotate on a schedule.

**2. The single-flight guard is per-process.** Two Node instances behind a load balancer will
still refresh concurrently. Harmless with Google, which keeps the old refresh token valid — but
**fatal with a provider that rotates refresh tokens on every use** (each refresh invalidates the
previous one, so the loser of the race is left holding a dead token and the integration dies).
The fix is a lock in shared state: a Postgres advisory lock (`pg_advisory_xact_lock`) or
`SELECT … FOR UPDATE` on the `oauth_accounts` row, so only one instance refreshes and the others
wait and re-read.

That second one is the honest answer to *"what would break if you ran two of these?"* — a
question worth expecting.

## The interview answer

> "Authorization code flow with `state` and PKCE. Tokens live in Postgres, upserted on a unique
> provider column. I refresh a minute before expiry behind a single-flight guard, and I keep the
> existing refresh token when the response doesn't include a new one — that omission is the most
> common way this integration dies silently, so I have a test pinning it. All API calls go
> through one wrapper that retries once on 401 and backs off with jitter on 429 and 5xx. On
> `invalid_grant` I delete the connection and alert staff instead of retrying, because retrying
> cannot fix a revoked grant. Two things I'd add for production: encryption at rest for the
> tokens, and a database-level lock instead of the in-process single-flight, because with a
> provider that rotates refresh tokens the loser of a cross-instance race ends up with a dead
> token."
