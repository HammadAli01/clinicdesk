import Link from "next/link";
import { Bot, CalendarPlus, CreditCard } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

// The three "front doors" into the same booking rules (see docs/00-orientation.md).
const channels = [
  {
    icon: CalendarPlus,
    title: "Book online",
    text: "Patients pick a service and a free time slot, right here on the website.",
  },
  {
    icon: Bot,
    title: "AI receptionist",
    text: "An AI agent books and cancels through the MCP server, using the same rules.",
  },
  {
    icon: CreditCard,
    title: "Deposits with Stripe",
    text: "Services that need a deposit hold the slot until the patient pays.",
  },
];

export default function Home() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-muted/40 px-6 py-24">
      <main className="flex w-full max-w-3xl flex-col items-center gap-10 text-center">
        <div className="flex flex-col items-center gap-4">
          <h1 className="text-4xl font-semibold tracking-tight">ClinicDesk</h1>
          <p className="max-w-xl text-lg text-muted-foreground">
            Book an appointment at the clinic in under a minute, online or through our AI
            receptionist.
          </p>
          {/* asChild: Button passes its styles to its only child (the Next.js Link), so we
              get a real <a> link that LOOKS like a button. */}
          <div className="flex flex-col gap-3 sm:flex-row">
            <Button asChild size="lg" className="px-6">
              <Link href="/book">Book an appointment</Link>
            </Button>
            <Button asChild size="lg" variant="outline" className="px-6">
              <Link href="/admin">Staff admin</Link>
            </Button>
          </div>
        </div>

        <div className="grid w-full gap-4 text-left sm:grid-cols-3">
          {/* Destructuring with rename: `icon: Icon` because JSX needs a capitalised name. */}
          {channels.map(({ icon: Icon, title, text }) => (
            <Card key={title} size="sm">
              <CardHeader>
                <Icon className="mb-2 size-5 text-primary" aria-hidden />
                <CardTitle>{title}</CardTitle>
                <CardDescription>{text}</CardDescription>
              </CardHeader>
            </Card>
          ))}
        </div>
      </main>
    </div>
  );
}
