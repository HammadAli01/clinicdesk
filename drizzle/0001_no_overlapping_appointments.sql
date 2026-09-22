-- Custom SQL migration file, put your code below! --

-- btree_gist lets GiST indexes also handle plain equality (needed later if
-- you add clinic_id WITH = for multi-tenancy). Harmless to enable now.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- No two non-cancelled appointments may overlap in time.
-- '[)' means start is inclusive, end is exclusive, so 10:00-11:00 and
-- 11:00-12:00 do NOT overlap.
-- This is a race-safe guarantee enforced by Postgres itself: a check-then-insert
-- in application code cannot prevent two concurrent requests from both passing
-- the check before either commits. The exclusion constraint makes the second
-- INSERT fail with error 23P01, which the service layer maps to a 409 "slot taken".
ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_no_overlap"
  EXCLUDE USING gist (tstzrange("starts_at", "ends_at", '[)') WITH &&)
  WHERE ("status" <> 'cancelled');

-- Belt-and-braces: an appointment that ends before (or exactly when) it starts
-- is never valid, regardless of overlap with anything else.
ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_ends_after_starts" CHECK ("ends_at" > "starts_at");
