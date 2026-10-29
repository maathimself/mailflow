import { Router } from 'express';
import { requireAuth, isPluginActivated, storage } from '../api.js';

const PLUGIN = 'templates';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const router = Router();
router.use(requireAuth);
router.use(async (req, res, next) => {
  if (!await isPluginActivated(req.session.userId, PLUGIN)) return res.status(403).json({ error: 'Templates plugin is disabled' });
  next();
});

function normalize(body) {
  if (!body || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 200) return null;
  if (typeof body.subject !== 'string' || body.subject.length > 2000 || /[\r\n]/.test(body.subject)) return null;
  if (typeof body.body !== 'string' || body.body.length > 1024 * 1024) return null;
  const result = { name: body.name.trim(), subject: body.subject, body: body.body };
  for (const field of ['to', 'cc', 'bcc']) {
    const values = body[field] ?? [];
    if (!Array.isArray(values) || values.length > 200) return null;
    const recipients = [];
    for (const recipient of values) {
      if (typeof recipient !== 'string' || recipient.length > 1000 || /[\r\n]/.test(recipient)) return null;
      const address = recipient.match(/<([^<>]+)>$/)?.[1] || recipient.trim();
      if (!/^[^\s@<>]+@[^\s@<>]+$/.test(address)) return null;
      recipients.push(recipient.trim());
    }
    result[field] = [...new Set(recipients)];
  }
  return result;
}

const keyFor = (userId, id) => `${userId}:${id}`;
const summary = ({ body: _body, ...value }) => { void _body; return value; };
async function owned(req) {
  if (!UUID.test(req.params.id)) return null;
  const record = await storage.getValue(PLUGIN, keyFor(req.session.userId, req.params.id));
  return record?.owner_id === req.session.userId ? record.value : null;
}

router.get('/', async (req, res) => {
  const records = await storage.listValues(PLUGIN, req.session.userId);
  res.json(records.map(record => summary(record.value)));
});

router.get('/:id', async (req, res) => {
  const template = await owned(req);
  if (!template) return res.status(404).json({ error: 'Template not found' });
  res.json(template);
});

router.post('/', async (req, res) => {
  const value = normalize(req.body);
  if (!value) return res.status(400).json({ error: 'Invalid template name, recipients, subject or body' });
  const id = globalThis.crypto.randomUUID();
  const template = { ...value, id, updatedAt: new Date().toISOString() };
  await storage.put(PLUGIN, keyFor(req.session.userId, id), { value: template, ownerId: req.session.userId });
  res.status(201).json(template);
});

router.put('/:id', async (req, res) => {
  if (!await owned(req)) return res.status(404).json({ error: 'Template not found' });
  const value = normalize(req.body);
  if (!value) return res.status(400).json({ error: 'Invalid template name, recipients, subject or body' });
  const template = { ...value, id: req.params.id, updatedAt: new Date().toISOString() };
  await storage.put(PLUGIN, keyFor(req.session.userId, req.params.id), { value: template, ownerId: req.session.userId });
  res.json(template);
});

router.delete('/:id', async (req, res) => {
  if (!await owned(req)) return res.status(404).json({ error: 'Template not found' });
  await storage.del(PLUGIN, keyFor(req.session.userId, req.params.id));
  res.status(204).end();
});

export default router;
