import { createGuardrails, generateSecret, generateURI, verify } from 'otplib';

export const TOTP_ISSUER = 'MailExpert';
const TOTP_SECRET_BYTES = 20;
const TOTP_TOKEN_RE = /^\d{6}$/;

// otplib 13 refuses secrets shorter than 16 bytes. otplib 12, which enrolled the stored
// secrets, accepted any length and defaulted to 10 bytes, so keep verifying those.
const verifyGuardrails = createGuardrails({ MIN_SECRET_BYTES: 10 });

// otplib 13 throws on input it cannot use (a malformed token, a missing or out-of-range
// secret) where otplib 12 returned false. A login code check must answer "invalid", not 500.
const REJECTED_INPUT_ERRORS = new Set([
  'TokenFormatError',
  'TokenLengthError',
  'SecretMissingError',
  'SecretTooShortError',
  'SecretTooLongError',
  'SecretTypeError',
  'Base32DecodeError',
]);

export function generateTotpSecret() {
  return generateSecret({ length: TOTP_SECRET_BYTES });
}

export function totpKeyUri(label, secret) {
  return generateURI({ issuer: TOTP_ISSUER, label, secret });
}

// Checks a 6-digit TOTP code for the current 30 s step only (no drift window), the
// same policy as the otplib 12 authenticator defaults it replaces.
export async function verifyTotp(token, secret) {
  if (typeof token !== 'string' || !TOTP_TOKEN_RE.test(token)) return false;
  if (typeof secret !== 'string' || !secret) return false;
  try {
    const result = await verify({ secret, token, guardrails: verifyGuardrails });
    return result.valid === true;
  } catch (err) {
    if (REJECTED_INPUT_ERRORS.has(err?.name)) return false;
    throw err;
  }
}
