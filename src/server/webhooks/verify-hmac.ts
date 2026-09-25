// Generic HMAC-SHA256 verification for vendors that hand you a raw secret and a signature
// header instead of an SDK with its own `constructEvent`. Same shape as Stripe's verification,
// minus the timestamp/replay check the SDK does for us -- add one per-vendor if needed.
//
// HMAC in plain words: sender and receiver share a secret. The sender computes
// HMAC(secret, body) -- a fingerprint that only someone holding the secret can produce -- and
// sends it in a header. We recompute it over the bytes we received. Same fingerprint => the body
// came from someone with the secret AND wasn't changed by a single byte on the way.
// Not encryption: the body is still readable. It proves WHO sent it and that it's UNCHANGED.

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * @param rawBody the exact request bytes as a string -- verify BEFORE parsing, same rule as Stripe.
 * @param signatureHex the signature header, hex-encoded.
 * @param secret the shared webhook secret.
 */
export function verifyHmacSha256(rawBody: string, signatureHex: string, secret: string): boolean {
  // .digest() with no argument returns raw bytes (a Buffer), 32 bytes for SHA-256.
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  // Buffer.from(..., "hex") never throws -- invalid/odd-length hex just decodes to fewer bytes --
  // so the real danger is below.
  const given = Buffer.from(signatureHex, "hex");

  // timingSafeEqual THROWS on a length mismatch instead of returning false -- a normal `===`
  // would also leak how many leading bytes matched through timing. Check the length first so a
  // wrong-length signature (attacker-supplied, or just a shorter/longer header) fails closed
  // instead of crashing the request handler.
  // `&&` short-circuits: if the lengths differ, timingSafeEqual is never called.
  return given.length === expected.length && timingSafeEqual(given, expected);
}
