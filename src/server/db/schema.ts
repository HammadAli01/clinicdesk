import { relations } from 'drizzle-orm';
import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// The database tables, written in TypeScript. Drizzle reads this file to
// generate SQL migrations (`pnpm db:generate`) and to type every query.
// Comment-only edits here do not change the schema.

// Always store time as "timestamp with time zone" (UTC under the hood).
// A tiny helper (arrow function) so every timestamp column is configured the same way.
// mode: 'date' = Drizzle hands us JS Date objects, not strings.
const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

// A Postgres enum: the column can only hold one of these values.
export const appointmentStatus = pgEnum('appointment_status', [
  'pending_payment', // slot held, waiting for the deposit
  'confirmed',
  'cancelled',
]);

export const services = pgTable(
  'services',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    durationMinutes: integer('duration_minutes').notNull(),
    priceCents: integer('price_cents').notNull(), // money as integers, never floats
    depositCents: integer('deposit_cents').notNull().default(0),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  // Added in migration 0003, after the table already existed. Two reasons:
  //  1. A clinic offering two services with the same name is a data-entry bug.
  //  2. It gives `seed.ts`'s .onConflictDoNothing() something to conflict ON.
  //     Without a unique constraint, "insert or ignore" silently means "insert",
  //     and running the seed twice gives you six services instead of three.
  (t) => [uniqueIndex('services_name_uq').on(t.name)],
);

// NOTE: the rule "no two non-cancelled appointments may overlap" is NOT here.
// Drizzle can't express an exclusion constraint, so it lives in hand-written
// SQL in drizzle/0001_no_overlapping_appointments.sql (error code 23P01).
export const appointments = pgTable(
  'appointments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // camelCase in TypeScript (`serviceId`), snake_case in SQL ('service_id').
    // `() => services.id` is a function so the reference is resolved lazily.
    serviceId: uuid('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'restrict' }), // foreign key: can't delete a service with appointment history
    customerName: text('customer_name').notNull(),
    customerPhone: text('customer_phone').notNull(),
    startsAt: tstz('starts_at').notNull(),
    endsAt: tstz('ends_at').notNull(),
    status: appointmentStatus('status').notNull().default('pending_payment'),
    // A plain TEXT column, but `enum` narrows its TypeScript type to the union
    // 'web' | 'ai_agent' | 'staff' (TS-only check; the DB itself allows any text).
    source: text('source', { enum: ['web', 'ai_agent', 'staff'] }).notNull(),
    stripeCheckoutSessionId: text('stripe_checkout_session_id'),
    googleEventId: text('google_event_id'),
    notes: text('notes'), // nullable: existing rows get NULL, no problem
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at')
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()), // Drizzle (app side, not a DB trigger) sets this on every .update()
  },
  (t) => [
    index('appointments_starts_at_idx').on(t.startsAt), // fast "what's on this day?"
    index('appointments_phone_idx').on(t.customerPhone),
  ],
);

export const oauthAccounts = pgTable(
  'oauth_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: text('provider', { enum: ['google'] }).notNull(),
    accessToken: text('access_token').notNull(),
    refreshToken: text('refresh_token').notNull(),
    expiresAt: tstz('expires_at').notNull(),
    scope: text('scope').notNull(),
    updatedAt: tstz('updated_at')
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex('oauth_accounts_provider_uq').on(t.provider)], // one Google account per clinic
);

export const webhookEvents = pgTable('webhook_events', {
  id: text('id').primaryKey(), // Stripe's event id (evt_...), so duplicates collide
  type: text('type').notNull(),
  status: text('status', { enum: ['processing', 'processed', 'failed'] }).notNull(),
  attempts: integer('attempts').notNull().default(1),
  error: text('error'),
  lastAttemptAt: tstz('last_attempt_at').notNull().defaultNow(),
  processedAt: tstz('processed_at'),
});

// Relations don't change the database. They teach Drizzle's query API how to join.
export const servicesRelations = relations(services, ({ many }) => ({
  appointments: many(appointments),
}));
export const appointmentsRelations = relations(appointments, ({ one }) => ({
  service: one(services, { fields: [appointments.serviceId], references: [services.id] }),
}));

// Types derived from the schema -- use these instead of writing interfaces by hand.
// $inferSelect = every column (what a SELECT returns). $inferInsert = columns
// with defaults or NULL allowed become optional (what an INSERT needs).
export type Service = typeof services.$inferSelect;
export type NewService = typeof services.$inferInsert;
export type Appointment = typeof appointments.$inferSelect; // a row you read
export type NewAppointment = typeof appointments.$inferInsert; // a row you insert
export type OauthAccount = typeof oauthAccounts.$inferSelect;
export type NewOauthAccount = typeof oauthAccounts.$inferInsert;
export type WebhookEvent = typeof webhookEvents.$inferSelect;
export type NewWebhookEvent = typeof webhookEvents.$inferInsert;
