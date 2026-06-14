-- Server-level policy flags for self-hosted mail server support
INSERT INTO system_settings (key, value) VALUES ('allow_private_hosts', 'false') ON CONFLICT (key) DO NOTHING;
INSERT INTO system_settings (key, value) VALUES ('allow_insecure_tls', 'false') ON CONFLICT (key) DO NOTHING;
INSERT INTO system_settings (key, value) VALUES ('allow_nonstandard_ports', 'false') ON CONFLICT (key) DO NOTHING;
