export function senderToValue(sender) {
  if (!sender) return '';
  return encodeURIComponent(JSON.stringify({
    accountId: sender.accountId,
    aliasId: sender.aliasId || null,
    fromEmail: sender.fromEmail || null,
  }));
}

export function valueToSender(value) {
  if (!value) return null;
  const parsed = JSON.parse(decodeURIComponent(value));
  return {
    accountId: parsed.accountId,
    aliasId: parsed.aliasId || null,
    fromEmail: parsed.fromEmail || null,
  };
}

// Resolves a message's server-side sender, degrading to manual selection when the
// lookup fails so a transient backend hiccup never blocks replying or opening a draft.
export async function resolveSenderOrFallback(resolve) {
  try {
    return await resolve();
  } catch {
    return { sender: null, requiresSelection: true };
  }
}

export function wildcardCovers(pattern, candidate) {
  const normalizedPattern = String(pattern || '').trim().toLowerCase();
  const normalizedCandidate = String(candidate || '').trim().toLowerCase();
  if (!normalizedPattern.startsWith('*@')) return false;
  const at = normalizedCandidate.lastIndexOf('@');
  return at > 0 && normalizedCandidate.slice(at + 1) === normalizedPattern.slice(2);
}

export function resolveSenderSignature({ account, alias, selectedSender, resolvedSender }) {
  if (alias) return alias.signature ?? account?.signature ?? null;
  if (
    resolvedSender?.signature !== undefined
    && senderToValue(selectedSender) === senderToValue(resolvedSender)
  ) {
    return resolvedSender.signature;
  }
  return account?.signature ?? null;
}

function senderLabel(name, email) {
  return name ? `${name} <${email}>` : email;
}

export function buildSenderOptions(account, resolvedSender = null) {
  const aliases = account.aliases || [];
  const wildcards = aliases.filter(alias => (
    alias.provenance === 'fastmail'
    && alias.fastmail_identity_id
    && alias.email.startsWith('*@')
  ));
  const options = [{
    label: `${account.sender_name || account.name} <${account.email_address}>`,
    sender: { accountId: account.id, aliasId: null, fromEmail: null },
  }];
  for (const alias of aliases) {
    if (alias.email.startsWith('*@')) continue;
    if (alias.provenance === 'manual' || alias.fastmail_identity_id) {
      options.push({
        label: senderLabel(alias.name, alias.email),
        sender: { accountId: account.id, aliasId: alias.id, fromEmail: null },
      });
      continue;
    }
    const wildcard = wildcards.find(item => wildcardCovers(item.email, alias.email));
    if (wildcard) {
      options.push({
        label: senderLabel(wildcard.name, alias.email),
        sender: { accountId: account.id, aliasId: wildcard.id, fromEmail: alias.email },
      });
    }
  }
  if (
    resolvedSender?.accountId === account.id
    && (resolvedSender.displayEmail || resolvedSender.fromEmail)
    && !options.some(option => senderToValue(option.sender) === senderToValue(resolvedSender))
  ) {
    const email = resolvedSender.displayEmail || resolvedSender.fromEmail;
    const name = resolvedSender.provenance === 'fastmail'
      ? resolvedSender.name
      : (resolvedSender.name || account.sender_name || account.name || '');
    options.push({
      label: senderLabel(name, email),
      sender: resolvedSender,
    });
  }
  return options;
}
