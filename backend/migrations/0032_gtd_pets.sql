-- User-imported Inbox-Zero pet assets (pet.json + spritesheet uploaded through
-- POST /gtd/pet/import; no URL is ever fetched). Keyed by the server-derived
-- per-user slug (gtdPet.customPetSlug).
--
-- Stored in Postgres rather than on disk because the backend container mounts no
-- persistent volume (all durable state lives in PG; precedent: contacts.photo_data
-- stores image bytes). The per-user choice of which pet to show is a flat user
-- preference (gtdPetSlug), not stored here.
CREATE TABLE IF NOT EXISTS gtd_pets (
  slug         TEXT PRIMARY KEY,
  display_name TEXT,
  -- Derived animation descriptor served to the frontend: grid dimensions, frame
  -- size, the at-rest static frame, and the hover sequence. See gtdPet.parsePetJson.
  descriptor   JSONB NOT NULL,
  sheet_data   BYTEA NOT NULL,
  sheet_mime   TEXT  NOT NULL,
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
