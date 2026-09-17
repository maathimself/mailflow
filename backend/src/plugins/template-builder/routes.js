import { Router } from 'express';
import { requireAuth } from '../api.js';
import { listTemplates, getTemplate, createTemplate, updateTemplate, deleteTemplate } from './templateStorage.js';
import { compileMjml } from './mjmlCompile.js';

const router = Router();
router.use(requireAuth);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/template-builder/templates — list all templates (metadata, no html blob).
router.get('/templates', async (req, res) => {
  try {
    const templates = await listTemplates(req.session.userId);
    res.json({ templates });
  } catch (err) {
    req.log?.error(err);
    res.status(500).json({ error: 'Failed to list templates' });
  }
});

// POST /api/template-builder/templates — create a new template.
router.post('/templates', async (req, res) => {
  const { name, description, blocks } = req.body ?? {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  try {
    const template = await createTemplate(req.session.userId, {
      name: name.trim(),
      description: typeof description === 'string' ? description : '',
      blocks: Array.isArray(blocks) ? blocks : [],
    });
    res.status(201).json({ template });
  } catch (err) {
    req.log?.error(err);
    res.status(500).json({ error: 'Failed to create template' });
  }
});

// GET /api/template-builder/templates/:id — single template with compiled html.
router.get('/templates/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid template id' });
  try {
    const template = await getTemplate(req.session.userId, req.params.id);
    if (!template) return res.status(404).json({ error: 'Template not found' });
    res.json({ template });
  } catch (err) {
    req.log?.error(err);
    res.status(500).json({ error: 'Failed to get template' });
  }
});

// PUT /api/template-builder/templates/:id — update name/description/blocks and recompile if blocks changed.
router.put('/templates/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid template id' });
  const { name, description, blocks, mjml } = req.body ?? {};
  try {
    let html;
    if (typeof mjml === 'string') {
      html = await compileMjml(mjml);
    }
    const template = await updateTemplate(req.session.userId, req.params.id, {
      ...(name !== undefined && { name: String(name).trim() }),
      ...(description !== undefined && { description: String(description) }),
      ...(blocks !== undefined && { blocks }),
      ...(html !== undefined && { html }),
    });
    if (!template) return res.status(404).json({ error: 'Template not found' });
    res.json({ template });
  } catch (err) {
    if (err.message?.startsWith('MJML compile error')) {
      return res.status(422).json({ error: err.message });
    }
    req.log?.error(err);
    res.status(500).json({ error: 'Failed to update template' });
  }
});

// DELETE /api/template-builder/templates/:id
router.delete('/templates/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid template id' });
  try {
    const deleted = await deleteTemplate(req.session.userId, req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Template not found' });
    res.status(204).end();
  } catch (err) {
    req.log?.error(err);
    res.status(500).json({ error: 'Failed to delete template' });
  }
});

// POST /api/template-builder/templates/:id/compile — compile MJML and store resulting HTML.
router.post('/templates/:id/compile', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid template id' });
  const { mjml } = req.body ?? {};
  if (!mjml || typeof mjml !== 'string') {
    return res.status(400).json({ error: 'mjml source is required' });
  }
  try {
    const html = await compileMjml(mjml);
    const template = await updateTemplate(req.session.userId, req.params.id, { html });
    if (!template) return res.status(404).json({ error: 'Template not found' });
    res.json({ html });
  } catch (err) {
    if (err.message?.startsWith('MJML compile error')) {
      return res.status(422).json({ error: err.message });
    }
    req.log?.error(err);
    res.status(500).json({ error: 'Failed to compile template' });
  }
});

export default router;
