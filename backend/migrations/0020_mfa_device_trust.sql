-- Add recovery email for email-OTP fallback
ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_email VARCHAR(255);

-- Trusted devices: persistent cookie-based trust after successful 2FA
CREATE TABLE IF NOT EXISTS trusted_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash VARCHAR(64) NOT NULL,
  device_label VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_trusted_devices_token_hash ON trusted_devices(token_hash);
CREATE INDEX IF NOT EXISTS idx_trusted_devices_user_id ON trusted_devices(user_id);

-- Email OTP tokens: short-lived codes sent to recovery email
CREATE TABLE IF NOT EXISTS email_otp_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash VARCHAR(64) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_email_otp_user_id ON email_otp_tokens(user_id);

-- MFA enforcement policy (off | required) and device trust duration (never | 7d | 30d | permanent)
INSERT INTO system_settings (key, value) VALUES
  ('mfa_enforcement', 'off'),
  ('mfa_device_trust', '30d')
ON CONFLICT (key) DO NOTHING;
