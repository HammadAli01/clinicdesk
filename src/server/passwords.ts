// Password hashing with scrypt (built into Node, no extra package).
//
// Why not sha256(password)? Fast hashes let an attacker with a stolen database
// try billions of guesses per second. scrypt is deliberately slow and memory-hungry,
// and a random per-user SALT means two people with the same password get different
// hashes, so one precomputed table can't crack everyone at once.
//
// Stored format: "scrypt$<salt base64url>$<hash base64url>"
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

// promisify turns scrypt's callback API into one that returns a Promise, so we can `await` it.
const scryptAsync = promisify(scrypt);
const KEY_LENGTH = 64;

async function derive(password: string, salt: Buffer): Promise<Buffer> {
  const key = await scryptAsync(password, salt, KEY_LENGTH);
  // promisify's typing of scrypt returns `unknown`; check it instead of casting.
  if (!Buffer.isBuffer(key)) throw new Error("scrypt did not return a Buffer");
  return key;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derive(password, salt);
  return `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

/** true if `password` matches `stored`. Constant-time; false for any malformed value. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, hashB64] = stored.split("$");
  if (scheme !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64url");
  const actual = await derive(password, Buffer.from(saltB64, "base64url"));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
