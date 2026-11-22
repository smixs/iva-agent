-- The tables of the install count; the statements live in src/lib/installs.ts (SCHEMA).
CREATE TABLE IF NOT EXISTS installs (name TEXT PRIMARY KEY, count INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS seen (day TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (day, hash)) WITHOUT ROWID;
