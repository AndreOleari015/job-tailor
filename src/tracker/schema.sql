-- One row per posting the tool has seen, from first sighting to outcome.
-- The status column is a state machine; transitions are enforced in store.ts,
-- not here, so an invalid one fails with a readable message rather than a
-- constraint violation.

CREATE TABLE IF NOT EXISTS postings (
    source_id   TEXT PRIMARY KEY,
    source      TEXT,
    company     TEXT,
    title       TEXT,
    location    TEXT,
    country     TEXT,
    url         TEXT,
    posted_at   TEXT,
    fetched_at  TEXT,
    -- Nullable on purpose: null means "no technology recognised", which is a
    -- different statement from a score of zero. Null sorts last.
    pre_score   INTEGER,
    raw_text    TEXT,
    -- "de" | "en" | "unknown", from the deterministic check in sources/language.ts.
    language    TEXT,
    status      TEXT NOT NULL DEFAULT 'new',
    out_dir     TEXT,
    match_score INTEGER,
    flags       TEXT,
    gaps        TEXT,
    applied_at  TEXT,
    outcome     TEXT,
    notes       TEXT,
    -- Why the last generation failed. Kept apart from `notes`, which is the
    -- operator's own writing and must never be overwritten by the machine.
    last_error  TEXT,
    updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS postings_status_idx ON postings (status);
CREATE INDEX IF NOT EXISTS postings_country_idx ON postings (country);
CREATE INDEX IF NOT EXISTS postings_source_idx ON postings (source);
