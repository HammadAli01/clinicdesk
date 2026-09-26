import { z } from "zod";
import { BookingForm } from "@/components/BookingForm";
import { PaymentStatus } from "@/components/PaymentStatus";

// Stripe's success_url is /book?paid=<appointmentId> (services/checkout.ts).
// Validate it at the boundary: anything that isn't a UUID is simply ignored.
const PaidParam = z.uuid();

// Next.js 16: searchParams is a Promise, so the page is async and awaits it.
export default async function BookPage(props: PageProps<"/book">) {
  const { paid } = await props.searchParams;
  const paidId = PaidParam.safeParse(paid);

  return (
    <main className="flex-1 py-10">
      <h1 className="text-center text-2xl font-semibold text-zinc-900">
        Book an appointment
      </h1>
      {paidId.success && <PaymentStatus appointmentId={paidId.data} />}
      <p className="mx-auto mt-2 max-w-md text-center text-sm text-zinc-600">
        Pick a service, a date and a free time slot. We will only ask for your name and
        phone number to confirm.
      </p>
      <BookingForm />
    </main>
  );
}
