import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyHmacSha256 } from "@/server/webhooks/verify-hmac";

const secret = "shared-secret";
const rawBody = JSON.stringify({ event: "order.paid", id: "ord_123" });

function sign(body: string, key = secret) {
  return createHmac("sha256", key).update(body).digest("hex");
}

describe("verifyHmacSha256", () => {
  it("verifies a correctly signed body", () => {
    expect(verifyHmacSha256(rawBody, sign(rawBody), secret)).toBe(true);
  });

  it("rejects a signature computed with the wrong secret", () => {
    expect(verifyHmacSha256(rawBody, sign(rawBody, "different-secret"), secret)).toBe(false);
  });

  it("rejects a signature for a body that was tampered with after signing", () => {
    const tampered = JSON.stringify({ event: "order.paid", id: "ord_999" });
    expect(verifyHmacSha256(tampered, sign(rawBody), secret)).toBe(false);
  });

  it("returns false (never throws) for a signature of the wrong length", () => {
    // A real sha256 HMAC hex-encodes to 64 characters. `timingSafeEqual` throws on a
    // buffer-length mismatch -- that is a crash-vs-false bug if not guarded against.
    expect(() => verifyHmacSha256(rawBody, "ab", secret)).not.toThrow();
    expect(verifyHmacSha256(rawBody, "ab", secret)).toBe(false);
  });
});
