// Validation for stored lists of bare email addresses, such as an account's automatic Cc and Bcc.

// A copy of FORWARD_EMAIL_RE in routes/rules.js: one address, with no display name.
const BARE_ADDRESS_RE = /^[^\s@<>(),;:]+@[^\s@<>(),;:]+\.[^\s@<>(),;:]+$/;
const MAX_ADDRESS_LENGTH = 254;

function invalid(message) {
  return Object.assign(new Error(message), { status: 400 });
}

export function normalizeAddressList(value, label, { max = 10 } = {}) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw invalid(`${label} must be a list of email addresses`);
  const seen = new Set();
  const addresses = [];
  for (const [i, entry] of value.entries()) {
    if (typeof entry !== 'string') throw invalid(`${label}: entry ${i + 1} is not a string`);
    const address = entry.trim();
    if (!address) continue;
    // Checked first, so the messages below never quote more than MAX_ADDRESS_LENGTH characters.
    if (address.length > MAX_ADDRESS_LENGTH) {
      throw invalid(`${label}: the address starting ${JSON.stringify(address.slice(0, 40))} is longer than ${MAX_ADDRESS_LENGTH} characters`);
    }
    if (/[\r\n\0]/.test(address)) throw invalid(`${label}: ${JSON.stringify(address)} contains invalid characters`);
    if (!BARE_ADDRESS_RE.test(address)) {
      throw invalid(`${label}: ${JSON.stringify(address)} is not a single email address (use name@example.com)`);
    }
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    addresses.push(address);
  }
  if (addresses.length > max) throw invalid(`${label}: at most ${max} addresses are allowed`);
  return addresses;
}
