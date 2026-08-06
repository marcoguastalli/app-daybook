-- app-daybook index schema.
-- The DB is only an index, always rebuildable from the md files: any schema
-- change is "drop the DB, recreate from this file, reindex" — no migrations.

CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- unaccent() is only STABLE; expression indexes and generated columns require
-- IMMUTABLE, hence this wrapper pinned to the extension's default dictionary.
CREATE OR REPLACE FUNCTION immutable_unaccent(text)
RETURNS text AS $$
  SELECT public.unaccent('public.unaccent'::regdictionary, $1)
$$ LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT;

-- 'simple' + unaccent as a filtering dictionary. Used by ts_headline so a
-- query typed without accents ("perche") still highlights the accented
-- original ("Perché") while the snippet keeps the real spelling. The
-- content_tsv generated column cannot use it (regconfig lookups are not
-- IMMUTABLE) and keeps to_tsvector('simple', immutable_unaccent(...)) —
-- both produce identical unaccented lexemes, so matching stays consistent.
-- No IF NOT EXISTS for TS configs; "already exists" surfaces as
-- unique_violation (not duplicate_object), so catch both — concurrent
-- appliers (parallel test files) can still race past the existence check.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'daybook_simple') THEN
    CREATE TEXT SEARCH CONFIGURATION daybook_simple (COPY = simple);
  END IF;
EXCEPTION WHEN unique_violation OR duplicate_object THEN NULL; END $$;
ALTER TEXT SEARCH CONFIGURATION daybook_simple
  ALTER MAPPING FOR asciiword, asciihword, hword_asciipart, word, hword, hword_part
  WITH unaccent, simple;

CREATE TABLE IF NOT EXISTS topics (
  id serial PRIMARY KEY,
  slug text UNIQUE NOT NULL,
  title text NOT NULL,
  description text,
  file_path text NOT NULL,
  file_mtime timestamptz NOT NULL,
  file_hash text NOT NULL,
  is_valid boolean NOT NULL DEFAULT true,
  validation_error text,
  indexed_at timestamptz NOT NULL
);

-- Fuzzy/typo-tolerant, accent-insensitive topic title matching + autocomplete.
CREATE INDEX IF NOT EXISTS topics_title_trgm_idx
  ON topics USING gin (immutable_unaccent(title) gin_trgm_ops);

CREATE TABLE IF NOT EXISTS entries (
  id serial PRIMARY KEY,
  topic_id integer NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  entry_date date NOT NULL,
  entry_time time,
  content text NOT NULL,
  -- 'simple' config: entries mix Italian, Spanish and English, so no stemming.
  content_tsv tsvector GENERATED ALWAYS AS
    (to_tsvector('simple', immutable_unaccent(content))) STORED,
  -- NULLS NOT DISTINCT enforces both the same-minute append rule and the
  -- "one timestamp-less entry per date" tolerance rule.
  CONSTRAINT entries_topic_date_time_key
    UNIQUE NULLS NOT DISTINCT (topic_id, entry_date, entry_time)
);

CREATE INDEX IF NOT EXISTS entries_content_tsv_idx
  ON entries USING gin (content_tsv);

CREATE TABLE IF NOT EXISTS wikilinks (
  id serial PRIMARY KEY,
  entry_id integer NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  -- Denormalized for fast topic-level backlink queries.
  source_topic_id integer NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  -- The target topic may not exist yet ("missing" link).
  target_slug text NOT NULL,
  CONSTRAINT wikilinks_entry_target_key UNIQUE (entry_id, target_slug)
);
