// Dev-only script (`pnpm db:seed`): inserts the three demo services.
// Idempotent: run it twice and you still have three services, because
// .onConflictDoNothing() skips rows that hit the unique index on `name`.

import { db } from './index';
import { services } from './schema';

// async main() + .catch() below: the CommonJS-friendly replacement for top-level await.
async function main() {
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
  process.exit(0); // close the DB pool's open handles so the script ends
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
