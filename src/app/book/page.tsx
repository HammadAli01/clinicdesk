import { BookingForm } from "@/components/BookingForm";

export default function BookPage() {
  return (
    <main className="flex-1 py-10">
      <h1 className="text-center text-2xl font-semibold text-zinc-900">
        Book an appointment
      </h1>
      <p className="mx-auto mt-2 max-w-md text-center text-sm text-zinc-600">
        Pick a service, a date and a free time slot. We will only ask for your name and
        phone number to confirm.
      </p>
      <BookingForm />
    </main>
  );
}
