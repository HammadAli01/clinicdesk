-- Postgres runs every .sql in /docker-entrypoint-initdb.d exactly once: the very
-- first time the data volume is created. It is NOT re-run on later `up`s.
--
-- The test suite points at this second database (see .env.test). Keeping tests
-- in their own database is what lets tests/setup.ts TRUNCATE freely without any
-- risk of wiping the data you seeded for a demo.
--
-- If you created your volume before this file existed, create it by hand once:
--   docker compose exec db createdb -U clinic clinicdesk_test
CREATE DATABASE clinicdesk_test OWNER clinic;
