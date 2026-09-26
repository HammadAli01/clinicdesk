// End-to-end booking flow: real Chromium, the real Next.js dev server, the
// real Postgres database. No mocks anywhere in the stack. This proves the
// *wiring* -- tRPC client to provider, superjson Dates surviving the round
// trip, the clinic's timezone reaching the DOM, a 409 reaching a visible
// error -- none of which the Vitest suite in tests/ can see, because it
// calls the service functions directly.
//
// Rules followed throughout:
//  - no `waitForTimeout` anywhere; only web-first assertions that retry.
//  - every date is relative to `now`, never a hardcoded calendar date.
//  - each test uses its own day offset so tests never fight over the same
//    slot and can run in any order, including in parallel.
//
// Playwright vocabulary used below (full primer in docs/11-browser-automation.md):
//  - browser  -- one launched Chromium process.
//  - context  -- an isolated "incognito profile" inside it: own cookies, storage, timezone.
//                Two contexts = two independent users. Cheap to create.
//  - page     -- one tab inside a context. The built-in `page` fixture gives each test a
//                fresh context + page automatically; `browser` is used when we need more.
//  - locator  -- a DESCRIPTION of how to find an element (e.g. getByTestId("slot-button")).
//                It is lazy: nothing is searched until you act on it or assert on it, and it
//                is re-resolved every time, so it survives React re-renders.
//  - `await expect(locator).toBeVisible()` -- a "web-first" assertion: Playwright keeps
//                re-checking until it passes or the timeout (5s default) runs out. This is
//                "auto-waiting", and it's why no test here needs a sleep.
//  - `page.goto("/book")` is relative: `baseURL` in playwright.config.ts supplies the host.
import { expect, test, type Page } from "@playwright/test";
// Pure, dependency-free clinic config (no DB, no env, no side effects) --
// safe to import into a Node test runner. This is NOT a "use client"
// component, so the src/server import restriction in CLAUDE.md (written for
// browser-bundled code) does not apply here; nothing in this file ships to
// a browser. Used only to compute the *expected* clinic-local slot time
// independently of the component under test, per the timezone test below.
import { CLINIC, localDayBounds } from "../src/server/services/slots";

// Mirrors the Intl config BookingForm uses to render a slot's time (see
// src/components/BookingForm.tsx). Duplicated here deliberately: the test
// computes its own expectation instead of importing client component code.
const clinicTimeFmt = new Intl.DateTimeFormat("en-PK", {
  timeZone: CLINIC.timeZone,
  hour: "numeric",
  minute: "2-digit",
});

/**
 * The clinic's local calendar date, `daysFromNow` days from the moment the
 * test runs, as "YYYY-MM-DD" (what the `date-input` expects). Asia/Karachi
 * has no daylight saving (fixed UTC+5), so shifting the instant by exactly
 * N * 24h always lands on the correct local calendar day.
 */
function karachiDateString(daysFromNow: number): string {
  const instant = new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Karachi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant); // [{type:"year",value:"2026"}, {type:"literal",value:"-"}, ...]
  // `?.value ?? "1970"`: if `find` returns undefined, `?.` yields undefined and `??` supplies a
  // fallback -- satisfies strict TypeScript without a `!` non-null assertion.
  const year = parts.find((p) => p.type === "year")?.value ?? "1970";
  const month = parts.find((p) => p.type === "month")?.value ?? "01";
  const day = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

/**
 * Selects the "Consultation" service -- the one zero-deposit service, so
 * booking it confirms immediately instead of redirecting to Stripe Checkout.
 *
 * The obvious selector, `selectOption({ label: 'Consultation' })`, does not
 * match the
 * real markup: Team UI's option text is "Consultation — 30 min — Rs 30.00"
 * (name + duration + price), and Playwright's `label` match is exact, not a
 * substring. So instead this locates the <option> by substring text, reads
 * its real `value` (the service's database id), and selects by that value.
 */
async function selectConsultation(page: Page): Promise<void> {
  const select = page.getByTestId("service-select");
  const consultationOption = select.locator("option", { hasText: "Consultation" });
  // Also doubles as the wait for the services query to finish loading. A
  // generous timeout: the first request against a cold `next dev` compile
  // can take longer than Playwright's 5s assertion default.
  await expect(consultationOption).toHaveCount(1, { timeout: 15_000 });
  const value = await consultationOption.getAttribute("value");
  if (value === null || value === "") {
    throw new Error("Consultation <option> has no value attribute to select by.");
  }
  await select.selectOption(value);
}

const VALID_PHONE = "03001234567"; // matches BookInput's phone regex, no uniqueness required

// test.describe groups related tests (shows as a heading in the report).
// `async ({ page }) => ...` DESTRUCTURES a "fixture": Playwright sees you asked for `page`,
// creates a fresh isolated context + tab for this test, and closes it afterwards.
test.describe("booking flow", () => {
  test("happy path: book the zero-deposit Consultation service", async ({ page }) => {
    await page.goto("/book");
    await selectConsultation(page);
    await page.getByTestId("date-input").fill(karachiDateString(1));

    // Many slot buttons match; `.first()` narrows the locator to one. Waiting for visibility
    // doubles as "wait until the slots query has returned".
    const firstSlot = page.getByTestId("slot-button").first();
    await expect(firstSlot).toBeVisible();
    // Actions like click()/fill() auto-wait too: element attached, visible, enabled, stable.
    await firstSlot.click();

    await page.getByTestId("name-input").fill("E2E Happy Path");
    await page.getByTestId("phone-input").fill(VALID_PHONE);
    await page.getByTestId("submit-button").click();

    await expect(page.getByTestId("success-message")).toBeVisible();
  });

  // The single most valuable test in this suite: the 409 -> UI path. A
  // second browser context books the exact same slot right after the first
  // one succeeds, and the customer must see why their booking failed.
  test("booking a slot that was just taken surfaces an error to the user", async ({
    browser,
  }) => {
    const dateStr = karachiDateString(2);

    // Two separate contexts = two separate patients on two separate devices. Contexts we
    // create ourselves are NOT auto-closed, hence the try/finally below.
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    try {
      await pageA.goto("/book");
      await selectConsultation(pageA);
      await pageA.getByTestId("date-input").fill(dateStr);
      const slotA = pageA.getByTestId("slot-button").first();
      await expect(slotA).toBeVisible();
      const slotLabel = await slotA.innerText();
      await slotA.click();
      await pageA.getByTestId("name-input").fill("E2E Conflict Winner");
      await pageA.getByTestId("phone-input").fill(VALID_PHONE);

      // pageB independently loads the same, still-free slot list and picks
      // the identical time by label -- not just "the first button" -- so
      // both browsers are provably contending for the same appointment.
      await pageB.goto("/book");
      await selectConsultation(pageB);
      await pageB.getByTestId("date-input").fill(dateStr);
      const slotB = pageB.getByTestId("slot-button").filter({ hasText: slotLabel }).first();
      await expect(slotB).toBeVisible();
      await slotB.click();
      await pageB.getByTestId("name-input").fill("E2E Conflict Loser");
      await pageB.getByTestId("phone-input").fill(VALID_PHONE);

      await pageA.getByTestId("submit-button").click();
      await expect(pageA.getByTestId("success-message")).toBeVisible();

      await pageB.getByTestId("submit-button").click();
      await expect(pageB.getByTestId("error-message")).toBeVisible();
      await expect(pageB.getByTestId("error-message")).toContainText("just taken");
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test("a date with no availability shows the empty state, not a blank list", async ({
    page,
  }) => {
    await page.goto("/book");
    await selectConsultation(page);
    // A past date: every slot on it is filtered out by computeFreeSlots'
    // "not in the past" rule, so it is always free of availability, on any
    // machine, on any run.
    await page.getByTestId("date-input").fill(karachiDateString(-3));

    await expect(page.getByText("No free slots that day. Try another date.")).toBeVisible();
    await expect(page.getByTestId("slot-button")).toHaveCount(0);
  });

  test("slot times render in the clinic's timezone, not the browser's", async ({ browser }) => {
    // A date dedicated to this test alone and never booked by any other
    // test in this suite, so its earliest slot always stays at opening time
    // no matter how many times the suite runs against the same database.
    const dateStr = karachiDateString(10);
    const day = localDayBounds(dateStr);
    const expectedFirstSlotInstant = new Date(
      day.start.getTime() + CLINIC.openHour * 60 * 60_000,
    );
    const expectedLabel = clinicTimeFmt.format(expectedFirstSlotInstant);

    // Run the browser itself in a timezone nowhere near Asia/Karachi. If the
    // component ever fell back to the viewer's local zone (e.g. a missing
    // `timeZone` option), this would render a different hour and the
    // assertion below would fail.
    const context = await browser.newContext({ timezoneId: "America/Los_Angeles" });
    const page = await context.newPage();

    try {
      await page.goto("/book");
      await selectConsultation(page);
      await page.getByTestId("date-input").fill(dateStr);

      const firstSlot = page.getByTestId("slot-button").first();
      await expect(firstSlot).toBeVisible();
      await expect(firstSlot).toHaveText(expectedLabel);
    } finally {
      await context.close();
    }
  });
});

test.describe("landing page", () => {
  // getByRole finds elements the way a screen reader does: by ARIA role + accessible name.
  // It's Playwright's recommended locator because it also checks the page is accessible.
  test("links to the booking page and the staff admin page", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("link", { name: "Book an appointment" })).toHaveAttribute(
      "href",
      "/book",
    );
    await expect(page.getByRole("link", { name: "Staff admin" })).toHaveAttribute(
      "href",
      "/admin",
    );
  });
});

test.describe("staff admin", () => {
  // The whole staff journey: a patient books, staff sign in, staff cancel it.
  // ADMIN_TOKEN comes from the environment (CI: the workflow's env; locally:
  // .env.local, loaded in playwright.config.ts).
  test("staff sign in and cancel a booking; it disappears from the list", async ({ page }) => {
    const adminToken = process.env.ADMIN_TOKEN;
    test.skip(!adminToken, "ADMIN_TOKEN is not set for the test runner");
    const patient = `E2E Staff ${Date.now()}`; // unique, so we find OUR row in a shared dev DB

    // 1. A patient books (day +5: no other test uses that day).
    await page.goto("/book");
    await selectConsultation(page);
    await page.getByTestId("date-input").fill(karachiDateString(5));
    await page.getByTestId("slot-button").first().click();
    await page.getByTestId("name-input").fill(patient);
    await page.getByTestId("phone-input").fill(VALID_PHONE);
    await page.getByTestId("submit-button").click();
    await expect(page.getByTestId("success-message")).toContainText(patient);

    // 2. Signed out, /admin offers a sign-in link instead of hanging on "Loading…".
    await page.goto("/admin");
    await page.getByTestId("admin-login-link").click();
    await page.getByTestId("admin-token-input").fill(adminToken ?? "");
    await page.getByTestId("admin-login-button").click();
    await expect(page).toHaveURL(/\/admin$/);

    // 3. Cancel our row. window.confirm() is a native dialog: accept it when it opens.
    const row = page.getByRole("listitem").filter({ hasText: patient });
    await expect(row).toBeVisible();
    page.once("dialog", (dialog) => dialog.accept());
    await row.getByTestId("cancel-button").click();
    await expect(row).toHaveCount(0);
  });
});
