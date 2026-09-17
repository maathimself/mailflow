import { storage } from '../api.js';
import { randomUUID } from 'node:crypto';

const PLUGIN_ID = 'template-builder';

// Key prefix for all templates owned by a user.
const templateKey = (userId, id) => `template:${userId}:${id}`;
const TEMPLATE_PREFIX = (userId) => `template:${userId}:`;

// List all templates for a user (metadata only, no blob).
export async function listTemplates(userId) {
  const { rows } = await storage.listByOwner(PLUGIN_ID, userId);
  return rows
    .filter(row => row.key.startsWith(TEMPLATE_PREFIX(userId)))
    .map(row => row.value);
}

// Get a single template (metadata + compiled html from blob).
export async function getTemplate(userId, id) {
  const key = templateKey(userId, id);
  const meta = await storage.getValue(PLUGIN_ID, key);
  if (!meta || meta.owner_id !== userId) return null;
  const blobRow = await storage.getBlob(PLUGIN_ID, key);
  return {
    ...meta.value,
    html: blobRow?.blob ? blobRow.blob.toString('utf8') : null,
  };
}

// Create a new template. Returns the created metadata.
export async function createTemplate(userId, { name, description = '', blocks = [] }) {
  const id = randomUUID();
  const key = templateKey(userId, id);
  const now = new Date().toISOString();
  const value = { id, name, description, blocks, createdAt: now, updatedAt: now };
  await storage.put(PLUGIN_ID, key, { value, ownerId: userId });
  return value;
}

// Update template metadata and optionally its compiled HTML blob.
export async function updateTemplate(userId, id, { name, description, blocks, html }) {
  const key = templateKey(userId, id);
  const existing = await storage.getValue(PLUGIN_ID, key);
  if (!existing || existing.owner_id !== userId) return null;
  const updated = {
    ...existing.value,
    ...(name !== undefined && { name }),
    ...(description !== undefined && { description }),
    ...(blocks !== undefined && { blocks }),
    updatedAt: new Date().toISOString(),
  };
  const blob = html !== undefined ? Buffer.from(html, 'utf8') : undefined;
  const mime = html !== undefined ? 'text/html' : undefined;
  await storage.put(PLUGIN_ID, key, {
    value: updated,
    ownerId: userId,
    ...(blob !== undefined && { blob, mime }),
  });
  return updated;
}

// Delete a template.
export async function deleteTemplate(userId, id) {
  const key = templateKey(userId, id);
  const existing = await storage.getValue(PLUGIN_ID, key);
  if (!existing || existing.owner_id !== userId) return false;
  await storage.del(PLUGIN_ID, key);
  return true;
}
