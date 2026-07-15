-- Multi-address-book CardDAV: separate "the user deliberately wants
-- this contact in their address book" from is_auto.
--
-- routes/send.js sets is_auto = false on any contact the user sends mail to, and
-- routes/search.js ranks autocomplete on exactly that flag ("contacts the user
-- explicitly sent to or manually created"). is_auto therefore cannot also mean
-- "publish this to CardDAV" — gating publication on it means replying to a
-- harvested sender silently pushes them into the user's shared address book.
-- Publication is gated on this column instead; is_auto keeps its upstream meaning
-- and send.js is untouched, so autocomplete ranking is unaffected.
--
-- Backfill = NOT is_auto: every contact that is explicit on the old schema is
-- being exported by the sweep today, so it keeps exporting. The false default
-- applies only to rows created from here on, where a contact that became explicit
-- merely by being emailed is not published until the user deliberately promotes
-- it (or turns on the publishEmailedContacts setting).
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS carddav_publish_intent BOOLEAN NOT NULL DEFAULT false;

UPDATE contacts SET carddav_publish_intent = true WHERE is_auto = false;
