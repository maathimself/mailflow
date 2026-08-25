import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const imapSource = readFileSync(new URL('./imapManager.js', import.meta.url), 'utf8');
const desiredFlagSource = readFileSync(new URL('./desiredFlags.js', import.meta.url), 'utf8');
const archiveSource = readFileSync(new URL('./archiveInbox.js', import.meta.url), 'utf8');

function rawMutationLines(source) {
  return source.split('\n')
    .map(line => line.trim())
    .filter(line => /\bclient\.(messageMove|messageCopy|messageDelete|messageFlagsAdd|messageFlagsRemove|append)\(/.test(line));
}

describe('provider mutation boundary allowlist', () => {
  it('keeps raw IMAP writes inside the reviewed durable executor primitives', () => {
    expect(rawMutationLines(imapSource)).toEqual([
      'const stored = await client.messageFlagsAdd(String(uid), [marker], { uid: true });',
      'const removed = await client.messageFlagsRemove(String(uid), [marker], { uid: true });',
      'const result = await client.append(folder, rawMessage, appendFlags);',
      'const result = await client.messageMove(String(uid), toFolder, { uid: true });',
      'const result = await client.messageDelete(String(uid), { uid: true });',
      'const copyResult = await client.messageCopy(String(uid), toFolder, { uid: true });',
    ]);
  });

  it('keeps raw flag STORE calls inside the desired-flag delivery session', () => {
    expect(rawMutationLines(desiredFlagSource)).toEqual([
      '? client.messageFlagsAdd(uid, [imapFlag], options)',
      ': client.messageFlagsRemove(uid, [imapFlag], options);',
    ]);
  });

  it('allows only the receipt-fenced All Mail completion to apply accepted flags before cascade', () => {
    expect(rawMutationLines(archiveSource)).toEqual([
      '? await providerResource.client.messageFlagsAdd(String(receipt.uid), [imapFlag], { uid: true })',
      ': await providerResource.client.messageFlagsRemove(String(receipt.uid), [imapFlag], { uid: true });',
    ]);
  });

  it('does not reintroduce bypass-capable mutation exports or manager methods', () => {
    expect(imapSource).not.toMatch(/export async function (?:moveMessageOnClient|copyMessageOnClient|appendMessageOnClient)\b/);
    expect(imapSource).not.toMatch(/async (?:setFlag|moveMessageGetNewUid|emptyFolder|markAllReadImap|clearMoveRecoveryKeyword|_bulkMoveMessages|bulkPermanentDelete)\b/);
  });
});
