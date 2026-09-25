import Stripe from 'stripe';
import { env } from '@/env';

// One Stripe client for the whole server. The SDK pins its own API version, so
// upgrading the package is what changes the API version — deliberately, in a
// diff you can review, rather than silently on Stripe's schedule.
// (stripe@22.6.2 pins '2026-08-26.dahlia'; see node_modules/stripe/cjs/apiVersion.js.)
//
// Pattern: module-level singleton. Node caches modules, so every `import { stripe }` gets
// this same instance (one connection pool, one config). Services don't import it directly,
// though -- they receive it as a parameter (`deps.stripe`) so tests can hand in their own.
//
// STRIPE_SECRET_KEY ("sk_test_..." / "sk_live_...") can move real money. It lives only in
// server env vars, validated at startup by src/env.ts, and must never reach browser code.
export const stripe = new Stripe(env.STRIPE_SECRET_KEY);

// `typeof stripe` reads the TYPE of a value -- lets other files name "our Stripe client type"
// without importing the instance itself.
export type StripeClient = typeof stripe;
