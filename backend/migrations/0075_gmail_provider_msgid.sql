-- Gmail's provider identifier is distinct from RFC Message-ID and folder UID.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS provider_msgid text;
