import Link from "next/link";

export default function Home() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-zinc-50 px-6 py-24">
      <main className="flex w-full max-w-xl flex-col items-center gap-6 text-center">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-900">ClinicDesk</h1>
        <p className="text-lg leading-8 text-zinc-600">
          ClinicDesk is a booking backend for a clinic&apos;s AI receptionist. Patients can
          check availability and book an appointment online, an AI agent can do the same
          over MCP, and Stripe collects deposits when a service requires one — all three
          callers share the same booking rules underneath.
        </p>
        <div className="flex flex-col gap-4 text-base font-medium sm:flex-row">
          <Link
            href="/book"
            className="flex h-12 w-40 items-center justify-center rounded-full bg-teal-700 text-white transition-colors hover:bg-teal-800"
          >
            Book an appointment
          </Link>
          <Link
            href="/admin"
            className="flex h-12 w-40 items-center justify-center rounded-full border border-zinc-300 text-zinc-800 transition-colors hover:border-teal-700"
          >
            Staff admin
          </Link>
        </div>
      </main>
    </div>
  );
}
