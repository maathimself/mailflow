import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api.js', () => ({ requireAuth: vi.fn((req, res, next) => next()) }));
vi.mock('./templateStorage.js', () => ({
  listTemplates: vi.fn(),
  getTemplate: vi.fn(),
  createTemplate: vi.fn(),
  updateTemplate: vi.fn(),
  deleteTemplate: vi.fn(),
}));
vi.mock('./mjmlCompile.js', () => ({ compileMjml: vi.fn() }));

import { listTemplates, getTemplate, createTemplate, updateTemplate, deleteTemplate } from './templateStorage.js';
import { compileMjml } from './mjmlCompile.js';

import express from 'express';
import router from './routes.js';

const USER = 'user-1';
const ID = '11111111-1111-1111-1111-111111111111';
const TEMPLATE = { id: ID, name: 'T', description: '', blocks: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { userId: USER }; next(); });
  app.use('/api/template-builder', router);
  return app;
}

let base;
let server;

beforeEach(async () => {
  vi.clearAllMocks();
  await new Promise((resolve) => {
    server = buildApp().listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('GET /templates', () => {
  it('returns list of templates', async () => {
    listTemplates.mockResolvedValue([TEMPLATE]);
    const res = await fetch(`${base}/api/template-builder/templates`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.templates).toHaveLength(1);
    expect(body.templates[0].id).toBe(ID);
  });
});

describe('POST /templates', () => {
  it('creates a template and returns 201', async () => {
    createTemplate.mockResolvedValue(TEMPLATE);
    const res = await fetch(`${base}/api/template-builder/templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'T', blocks: [] }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.template.id).toBe(ID);
  });

  it('returns 400 when name is missing', async () => {
    const res = await fetch(`${base}/api/template-builder/templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocks: [] }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when name is blank', async () => {
    const res = await fetch(`${base}/api/template-builder/templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '   ' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /templates/:id', () => {
  it('returns template with html', async () => {
    getTemplate.mockResolvedValue({ ...TEMPLATE, html: '<html/>' });
    const res = await fetch(`${base}/api/template-builder/templates/${ID}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.template.html).toBe('<html/>');
  });

  it('returns 404 when not found', async () => {
    getTemplate.mockResolvedValue(null);
    const res = await fetch(`${base}/api/template-builder/templates/${ID}`);
    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid uuid', async () => {
    const res = await fetch(`${base}/api/template-builder/templates/not-a-uuid`);
    expect(res.status).toBe(400);
  });
});

describe('PUT /templates/:id', () => {
  it('updates and returns template', async () => {
    updateTemplate.mockResolvedValue({ ...TEMPLATE, name: 'Updated' });
    const res = await fetch(`${base}/api/template-builder/templates/${ID}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Updated' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.template.name).toBe('Updated');
  });

  it('compiles mjml when provided', async () => {
    compileMjml.mockResolvedValue('<html>compiled</html>');
    updateTemplate.mockResolvedValue(TEMPLATE);
    const res = await fetch(`${base}/api/template-builder/templates/${ID}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mjml: '<mjml/>' }),
    });
    expect(res.status).toBe(200);
    expect(compileMjml).toHaveBeenCalledWith('<mjml/>');
  });

  it('returns 422 on MJML compile error', async () => {
    compileMjml.mockRejectedValue(new Error('MJML compile error: bad tag'));
    const res = await fetch(`${base}/api/template-builder/templates/${ID}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mjml: '<bad/>' }),
    });
    expect(res.status).toBe(422);
  });

  it('returns 404 when not found', async () => {
    updateTemplate.mockResolvedValue(null);
    const res = await fetch(`${base}/api/template-builder/templates/${ID}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'X' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /templates/:id', () => {
  it('returns 204 on success', async () => {
    deleteTemplate.mockResolvedValue(true);
    const res = await fetch(`${base}/api/template-builder/templates/${ID}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
  });

  it('returns 404 when not found', async () => {
    deleteTemplate.mockResolvedValue(false);
    const res = await fetch(`${base}/api/template-builder/templates/${ID}`, { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});

describe('POST /templates/:id/compile', () => {
  it('compiles and stores html, returns html', async () => {
    compileMjml.mockResolvedValue('<html>ok</html>');
    updateTemplate.mockResolvedValue(TEMPLATE);
    const res = await fetch(`${base}/api/template-builder/templates/${ID}/compile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mjml: '<mjml><mj-body/></mjml>' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.html).toBe('<html>ok</html>');
  });

  it('returns 400 when mjml is missing', async () => {
    const res = await fetch(`${base}/api/template-builder/templates/${ID}/compile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('returns 422 on MJML compile error', async () => {
    compileMjml.mockRejectedValue(new Error('MJML compile error: oops'));
    const res = await fetch(`${base}/api/template-builder/templates/${ID}/compile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mjml: '<bad/>' }),
    });
    expect(res.status).toBe(422);
  });
});
