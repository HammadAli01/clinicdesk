// Seed script (`pnpm db:seed`): inserts the three demo services and, if
// SEED_ADMIN_EMAIL + SEED_ADMIN_PASSWORD are set, the first staff account.
// Idempotent: run it twice and nothing is duplicated, because both inserts use
// ON CONFLICT DO NOTHING against a unique index (services.name, staff_users.email).

import { z } from 'zod';
import { createStaffUser } from '../services/staff';
import { db } from './index';
import { services } from './schema';

// Read at the boundary with Zod. Both optional: without them we just skip the admin.
// Kept out of src/env.ts on purpose: the running app never needs these, only this script.
const SeedEnv = z.object({
  SEED_ADMIN_EMAIL: z.email().optional(),
  SEED_ADMIN_PASSWORD: z.string().min(12, 'SEED_ADMIN_PASSWORD must be at least 12 characters').optional(),
});

// async main() + .catch() below: the CommonJS-friendly replacement for top-level await.
async function main() {
  const seedEnv = SeedEnv.parse(process.env);

  await db
    .insert(services)
    // Money in integer cents: 3000 = 30.00. Never floats (0.1 + 0.2 !== 0.3).
    .values([
      { name: 'Consultation', durationMinutes: 30, priceCents: 3000, depositCents: 0 },
      { name: 'HydraFacial', durationMinutes: 60, priceCents: 12000, depositCents: 2000 },
      { name: 'Laser session', durationMinutes: 90, priceCents: 20000, depositCents: 5000 },
    ])
    .onConflictDoNothing();
  console.log('Seeded services');

  const { SEED_ADMIN_EMAIL: email, SEED_ADMIN_PASSWORD: password } = seedEnv;
  if (email && password) {
    const created = await createStaffUser(db, { email, password });
    // Never print the password. The email is fine.
    console.log(created ? `Created staff account ${created.email}` : `Staff account ${email} already exists`);
  } else {
    console.log('No SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD set: skipped the staff account');
  }

  process.exit(0); // close the DB pool's open handles so the script ends
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
