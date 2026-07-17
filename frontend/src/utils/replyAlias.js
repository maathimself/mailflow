export function parseAddressListField(value) {
  if (Array.isArray(value)) return value;
  try {
    return JSON.parse(value || '[]');
  } catch {
    return [];
  }
}

export function pickReplyAlias({ aliases, deliveryAddresses, toAddresses, ccAddresses, fromEmail }) {
  if (!aliases || !aliases.length) return null;

  const delivered = parseAddressListField(deliveryAddresses).map(e => (e || '').toLowerCase()).filter(Boolean);
  const to = parseAddressListField(toAddresses).map(a => a.email?.toLowerCase()).filter(Boolean);
  const cc = parseAddressListField(ccAddresses).map(a => a.email?.toLowerCase()).filter(Boolean);
  const from = (fromEmail || '').toLowerCase();

  const deliveredMatch = aliases.find(al => delivered.includes(al.email.toLowerCase()));
  if (deliveredMatch) return deliveredMatch.id;

  // Same scan as before delivery addresses existed: aliases in creation order
  // against the combined To/Cc/From set, so multi-alias picks don't change.
  const headerEmails = [...to, ...cc];
  const match = aliases.find(al => {
    const aliasEmail = al.email.toLowerCase();
    return headerEmails.includes(aliasEmail) || (from && from === aliasEmail);
  });
  return match ? match.id : null;
}
