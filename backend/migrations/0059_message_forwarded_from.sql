-- Original sender of a message re-wrapped by an alias-forwarding service (33Mail, ...). The
-- service's own address is in From; the original sender survives only as text in the display
-- name ("Stripe 'billing@stripe.com' via 33Mail"). Derived only when From is on the service's own
-- domain and the message carries the service's marks, and stored apart from From because it is
-- sender-controlled text: surfaced as a separate, labelled line in the message pane, never in
-- place of From. Null for all other mail. See issue #475.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS forwarded_from_email VARCHAR(500);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS forwarded_from_name VARCHAR(500);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS forwarded_via VARCHAR(100);
