// Tags API: a user's tag definitions, the tags on messages, and setting a tag by hand.
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { imapManager } from '../index.js';
import {
  listDefinitions, createDefinition, updateDefinition, deleteDefinition, tagsForMessages, setManualTag, copiesOfMessage,
} from '../services/tags/store.js';

const router = Router();
router.use(requireAuth);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const bad = (res, error) => res.status(400).json({ error });
// Tell the user's other open tabs that the definitions changed (names, colors, which tags exist).
const definitionsChanged = (req) => imapManager.broadcast({ type: 'tag_definitions_updated' }, req.session.userId);
const TAKEN = 'A tag with this name already exists';

// Returns an error string, or null when `body` is a valid (partial) definition.
function validateDefinition(body, { partial }) {
  if ('name' in body ? !(typeof body.name === 'string' && body.name.trim() && body.name.trim().length <= 80) : !partial) return 'name is invalid';
  if ('color' in body && !(typeof body.color === 'string' && COLOR.test(body.color))) return 'color must be #rrggbb';
  return null;
}

router.get('/definitions', async (req, res) => {
  res.json(await listDefinitions(req.session.userId));
});

router.post('/definitions', async (req, res) => {
  const body = req.body ?? {};
  const err = validateDefinition(body, { partial: false });
  if (err) return bad(res, err);
  const created = await createDefinition(req.session.userId, { name: body.name.trim(), color: body.color });
  if (!created) return res.status(409).json({ error: TAKEN });
  definitionsChanged(req);
  res.status(201).json(created);
});

router.patch('/definitions/:id', async (req, res) => {
  if (!UUID.test(req.params.id)) return bad(res, 'Invalid id');
  const body = req.body ?? {};
  const err = validateDefinition(body, { partial: true });
  if (err) return bad(res, err);
  const patch = {};
  if ('name' in body) patch.name = body.name.trim();
  if ('color' in body) patch.color = body.color;
  const updated = await updateDefinition(req.session.userId, req.params.id, patch);
  if (updated === 'duplicate') return res.status(409).json({ error: TAKEN });
  if (!updated) return res.status(404).json({ error: 'Tag not found' });
  definitionsChanged(req);
  res.json(updated);
});

router.delete('/definitions/:id', async (req, res) => {
  if (!UUID.test(req.params.id)) return bad(res, 'Invalid id');
  if (!(await deleteDefinition(req.session.userId, req.params.id))) return res.status(404).json({ error: 'Tag not found' });
  definitionsChanged(req);
  res.json({ ok: true });
});

// Tags on a batch of messages (up to 200), as { messageId: [tag, ...] }.
router.get('/messages', async (req, res) => {
  const ids = String(req.query.ids || '').split(',').filter(Boolean);
  if (ids.length > 200 || ids.some((id) => !UUID.test(id))) return bad(res, 'ids must be up to 200 message ids');
  res.json(await tagsForMessages(req.session.userId, ids));
});

// Add (applied: true) or remove (applied: false) a tag on one message, by hand.
router.put('/messages/:id/tags/:tagId', async (req, res) => {
  if (!UUID.test(req.params.id) || !UUID.test(req.params.tagId)) return bad(res, 'Invalid id');
  if (typeof req.body?.applied !== 'boolean') return bad(res, 'applied (boolean) is required');
  if (!(await setManualTag(req.session.userId, req.params.id, req.params.tagId, req.body.applied))) {
    return res.status(404).json({ error: 'Message or tag not found' });
  }
  // Tags are per email, so every copy of it (another folder, All Inboxes) changed too.
  const messageIds = await copiesOfMessage(req.session.userId, req.params.id);
  imapManager.broadcast({ type: 'tags_updated', messageIds: messageIds.length ? messageIds : [req.params.id] }, req.session.userId);
  res.json({ ok: true });
});

export default router;
