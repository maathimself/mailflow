export function resolveSignatureEnabled(account, draftSignature) {
  if (draftSignature !== undefined) return draftSignature !== '';
  return account?.signature_enabled !== false;
}
