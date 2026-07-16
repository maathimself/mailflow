export const normalizeEmail = value => value?.toLowerCase().trim() || null;
const nonBlank = value => typeof value === 'string' && value.trim() ? value : null;

function compareRemote(left, right) {
  const discoveryOrder = Number(left.discoveryIndex ?? 0) - Number(right.discoveryIndex ?? 0);
  return discoveryOrder || left.href.localeCompare(right.href);
}

function exactlyOne(candidates) {
  return candidates.length === 1 ? candidates[0] : null;
}

export function planAutomaticProjection({ remoteObjects, mappings, localContacts }) {
  const orderedRemote = [...remoteObjects].sort(compareRemote);
  const orderedLocal = [...localContacts].sort((left, right) => (
    String(left.id).localeCompare(String(right.id))
  ));
  const localById = new Map(orderedLocal.map(contact => [contact.id, contact]));
  const mappingByHref = new Map(mappings.map(mapping => [mapping.href, mapping]));
  const claimedLocalIds = new Set(mappings
    .map(mapping => mapping.localContactId)
    .filter(Boolean));
  const available = orderedLocal.filter(contact => (
    (contact.isAuto === false || contact.is_auto === false)
    && !claimedLocalIds.has(contact.id)
  ));
  const links = [];
  const imports = [];

  for (const remote of orderedRemote) {
    const mapping = mappingByHref.get(remote.href);
    if (mapping?.localContactId && localById.has(mapping.localContactId)) {
      links.push({ href: remote.href, localContactId: mapping.localContactId });
      continue;
    }

    const candidates = available.filter(contact => !claimedLocalIds.has(contact.id));
    const uid = nonBlank(remote.contact?.uid);
    let target = uid
      ? exactlyOne(candidates.filter(contact => nonBlank(contact.uid) === uid))
      : null;
    if (!target) {
      const email = normalizeEmail(remote.contact?.primaryEmail);
      if (email) {
        target = exactlyOne(candidates.filter(contact => (
          normalizeEmail(contact.primaryEmail) === email
        )));
      }
    }

    if (!target) {
      imports.push({ href: remote.href });
      continue;
    }
    claimedLocalIds.add(target.id);
    links.push({ href: remote.href, localContactId: target.id });
  }

  const exports = available
    .filter(contact => !claimedLocalIds.has(contact.id))
    .map(contact => ({ localContactId: contact.id }));
  return { links, imports, exports };
}
