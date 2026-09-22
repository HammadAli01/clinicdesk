import { db } from './index';
import { services } from './schema';

async function main() {
  await db
    .insert(services)
    .values([
      { name: 'Consultation', durationMinutes: 30, priceCents: 3000, depositCents: 0 },
      { name: 'HydraFacial', durationMinutes: 60, priceCents: 12000, depositCents: 2000 },
      { name: 'Laser session', durationMinutes: 90, priceCents: 20000, depositCents: 5000 },
    ])
    .onConflictDoNothing();

  console.log('Seeded services');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
