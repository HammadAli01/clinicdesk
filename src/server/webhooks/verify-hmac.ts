// Generic HMAC-SHA256 verification for vendors that hand you a raw secret and a signature
// header instead of an SDK with its own `constructEvent`. Same shape as Stripe's verification,
// minus the timestamp/replay check the SDK does for us -- add one per-vendor if needed.

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * @param rawBody the exact request bytes as a string -- verify BEFORE parsing, same rule as Stripe.
 * @param signatureHex the signature header, hex-encoded.
 * @param secret the shared webhook secret.
 */
export function verifyHmacSha256(rawBody: string, signatureHex: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  // Buffer.from(..., "hex") never throws -- invalid/odd-length hex just decodes to fewer bytes --
  // so the real danger is below.
  const given = Buffer.from(signatureHex, "hex");

  // timingSafeEqual THROWS on a length mismatch instead of returning false -- a normal `===`
  // would also leak how many leading bytes matched through timing. Check the length first so a
  // wrong-length signature (attacker-supplied, or just a shorter/longer header) fails closed
  // instead of crashing the request handler.
  return given.length === expected.length && timingSafeEqual(given, expected);
}
