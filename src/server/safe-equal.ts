import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Constant-time string comparison for secrets (tokens, passwords).
 * A plain `===` stops at the first different character, so its timing leaks
 * how much of a guess was right. Hashing both sides first gives equal-length
 * buffers (timingSafeEqual throws on different lengths) and hides the secret's length.
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}
