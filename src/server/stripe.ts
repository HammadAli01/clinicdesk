import Stripe from 'stripe';
import { env } from '@/env';

// One Stripe client for the whole server. The SDK pins its own API version, so
// upgrading the package is what changes the API version — deliberately, in a
// diff you can review, rather than silently on Stripe's schedule.
export const stripe = new Stripe(env.STRIPE_SECRET_KEY);

export type StripeClient = typeof stripe;
