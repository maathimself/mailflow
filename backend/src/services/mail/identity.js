export class AliasNotFoundError extends Error {
  constructor(message = 'Alias not found') {
    super(message);
    this.name = 'AliasNotFoundError';
    this.status = 422;
    this.code = 'alias_not_found';
    this.expose = true;
  }
}

/**
 * Resolve a From identity for an account row already proven to belong to the caller.
 * A supplied selector must resolve within that account and never silently falls back.
 */
export async function resolveFromIdentity(account, selector = {}, deps = {}) {
  const defaultIdentity = {
    fromName: account.sender_name || account.name,
    fromEmail: account.email_address,
    fromReplyTo: null,
    signature: account.signature,
    aliasId: null,
  };

  const aliasId = selector?.aliasId;
  const aliasEmail = selector?.aliasEmail;
  if (!aliasId && !aliasEmail) return defaultIdentity;

  let result;
  if (aliasId) {
    result = await deps.query(
      'SELECT * FROM account_aliases WHERE id = $1 AND account_id = $2',
      [aliasId, account.id],
    );
  } else {
    result = await deps.query(
      'SELECT * FROM account_aliases WHERE account_id = $1 AND LOWER(email) = LOWER($2) LIMIT 1',
      [account.id, aliasEmail],
    );
  }

  const alias = result.rows[0];
  if (!alias) throw new AliasNotFoundError();

  return {
    fromName: alias.name,
    fromEmail: alias.email,
    fromReplyTo: alias.reply_to || null,
    // null (DB default) means inherit from account; only override when alias has an explicit signature set
    signature: alias.signature !== null ? alias.signature : defaultIdentity.signature,
    aliasId: alias.id,
  };
}
