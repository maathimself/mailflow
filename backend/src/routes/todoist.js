import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { encrypt, decrypt } from '../services/encryption.js';

const router = Router();
router.use(requireAuth);

async function getTodoistToken(userId) {
  const result = await query(
    "SELECT config FROM user_integrations WHERE user_id = $1 AND provider = 'todoist'",
    [userId]
  );
  if (!result.rows.length) {
    throw Object.assign(new Error('Todoist not connected'), { status: 409 });
  }
  return decrypt(result.rows[0].config.token);
}

async function todoistFetch(token, method, path, body) {
  const opts = {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`https://api.todoist.com/api/v1${path}`, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    // Todoist's 401 means it rejected the saved token, not the MailFlow session, and the
    // frontend signs the user out on any 401 outside /auth/.
    if (res.status === 401) {
      throw Object.assign(
        new Error('Todoist rejected the saved API token. Disconnect Todoist in MailFlow Settings → Integrations → Apps and connect it again with a new token.'),
        { status: 409 },
      );
    }
    throw Object.assign(new Error(err.error || `Todoist API error ${res.status}`), { status: res.status });
  }
  return res.json();
}

// GET /api/todoist/status
router.get('/status', async (req, res) => {
  try {
    const result = await query(
      "SELECT id FROM user_integrations WHERE user_id = $1 AND provider = 'todoist'",
      [req.session.userId]
    );
    res.json({ connected: result.rows.length > 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/todoist/connect
router.post('/connect', async (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string' || !token.trim()) {
    return res.status(400).json({ error: 'API token is required' });
  }
  const trimmed = token.trim();

  try {
    // Validate token against Todoist before storing
    const testRes = await fetch('https://api.todoist.com/api/v1/projects', {
      headers: { Authorization: `Bearer ${trimmed}` },
    });
    // Drain body to allow connection reuse
    await testRes.body?.cancel();
    if (!testRes.ok) {
      return res.status(400).json({ error: 'Invalid Todoist API token' });
    }

    const encryptedToken = encrypt(trimmed);
    await query(`
      INSERT INTO user_integrations (user_id, provider, config)
      VALUES ($1, 'todoist', $2)
      ON CONFLICT (user_id, provider) DO UPDATE
      SET config = EXCLUDED.config, updated_at = NOW()
    `, [req.session.userId, { token: encryptedToken }]);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/todoist/disconnect
router.delete('/disconnect', async (req, res) => {
  try {
    await query(
      "DELETE FROM user_integrations WHERE user_id = $1 AND provider = 'todoist'",
      [req.session.userId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/todoist/projects
router.get('/projects', async (req, res) => {
  try {
    const token = await getTodoistToken(req.session.userId);
    const data = await todoistFetch(token, 'GET', '/projects');
    res.json(data.results ?? data);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// GET /api/todoist/labels
router.get('/labels', async (req, res) => {
  try {
    const token = await getTodoistToken(req.session.userId);
    const data = await todoistFetch(token, 'GET', '/labels');
    res.json(data.results ?? data);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /api/todoist/tasks
router.post('/tasks', async (req, res) => {
  try {
    const token = await getTodoistToken(req.session.userId);
    const { content, description, project_id, labels, priority, due_string, due_date } = req.body;
    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Task title is required' });
    }
    const taskData = { content: content.trim() };
    if (description) taskData.description = description;
    if (project_id) taskData.project_id = project_id;
    if (labels?.length) taskData.labels = labels;
    if (priority && priority > 1) taskData.priority = priority;
    if (due_string) taskData.due_string = due_string;
    if (due_date) taskData.due_date = due_date;
    const task = await todoistFetch(token, 'POST', '/tasks', taskData);
    res.json({ ...task, url: `https://app.todoist.com/app/task/${task.id}` });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

export default router;
