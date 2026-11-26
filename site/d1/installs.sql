-- The tables of the counts: the install count (src/lib/installs.ts, SCHEMA) and the roll call
-- (src/lib/roll-call.ts, ROLL_CALL_SCHEMA). A test keeps this file equal to the two.
--   npx wrangler d1 execute <database> --remote --file d1/installs.sql
CREATE TABLE IF NOT EXISTS installs (name TEXT PRIMARY KEY, count INTEGER NOT NULL) WITHOUT ROWID;
DROP TABLE IF EXISTS seen;
CREATE TABLE IF NOT EXISTS roll_call (day TEXT NOT NULL, field TEXT NOT NULL, value TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (day, field, value)) WITHOUT ROWID;
