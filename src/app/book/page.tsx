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
    <main className="flex flex-1 flex-col gap-6 bg-muted/40 px-4 py-10">
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Book an appointment</h1>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
          Pick a service, a date and a free time slot. We will only ask for your name and
          phone number to confirm.
        </p>
      </div>
      {paidId.success && <PaymentStatus appointmentId={paidId.data} />}
      <BookingForm />
    </main>
  );
}
