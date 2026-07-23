import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import {
  deleteAiConfig,
  getAdminAiConfig,
  getAiStatus,
  saveAiConfig,
  streamChat,
  testAiProvider,
} from '../services/aiProvider.js';
import {
  cancelDeviceFlow,
  disconnectCodex,
  getCodexStatus,
  pollDeviceFlow,
  startDeviceFlow,
} from '../services/openaiCodexAuth.js';

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function serviceError(res, error, fallback = 'Request failed') {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600
    ? error.status
    : 500;
  const message = status >= 500 ? fallback : error.message;
  return res.status(status).json({ error: message });
}

function owner(req) {
  return { userId: req.session.userId, sessionId: req.sessionID };
}

function flowInput(req, res) {
  const flowId = typeof req.body?.flowId === 'string' ? req.body.flowId.trim() : '';
  if (!flowId) {
    res.status(400).json({ error: 'flowId is required' });
    return null;
  }
  if (!UUID_RE.test(flowId)) {
    res.status(400).json({ error: 'Invalid flowId' });
    return null;
  }
  return { flowId, ...owner(req) };
}

// ── Admin: AI provider configuration ──────────────────────────────────────────

router.get('/admin/ai', requireAdmin, async (_req, res) => {
  try {
    res.json({ config: await getAdminAiConfig() });
  } catch (error) {
    serviceError(res, error, 'Failed to load AI configuration');
  }
});

router.patch('/admin/ai', requireAdmin, async (req, res) => {
  try {
    const config = await saveAiConfig(req.body);
    console.log(`[admin] ${req.session.username} updated AI config`);
    res.json({ ok: true, config });
  } catch (error) {
    serviceError(res, error, 'Failed to save AI configuration');
  }
});

router.delete('/admin/ai', requireAdmin, async (_req, res) => {
  try {
    await deleteAiConfig();
    res.json({ ok: true });
  } catch (error) {
    serviceError(res, error, 'Failed to delete AI configuration');
  }
});

router.post('/admin/ai/test', requireAdmin, async (_req, res) => {
  try {
    res.json(await testAiProvider());
  } catch (error) {
    serviceError(res, error, 'AI provider test failed');
  }
});

// ── Admin: ChatGPT device authorization ──────────────────────────────────────

router.post('/admin/ai/codex/device', requireAdmin, async (req, res) => {
  try {
    res.json(await startDeviceFlow(owner(req)));
  } catch (error) {
    serviceError(res, error, 'Failed to start ChatGPT authorization');
  }
});

router.post('/admin/ai/codex/device/poll', requireAdmin, async (req, res) => {
  const input = flowInput(req, res);
  if (!input) return;
  try {
    res.json(await pollDeviceFlow(input));
  } catch (error) {
    serviceError(res, error, 'Failed to poll ChatGPT authorization');
  }
});

router.delete('/admin/ai/codex/device', requireAdmin, async (req, res) => {
  const input = flowInput(req, res);
  if (!input) return;
  try {
    res.json(await cancelDeviceFlow(input));
  } catch (error) {
    serviceError(res, error, 'Failed to cancel ChatGPT authorization');
  }
});

router.get('/admin/ai/codex/status', requireAdmin, async (req, res) => {
  try {
    res.json(await getCodexStatus(owner(req)));
  } catch (error) {
    serviceError(res, error, 'Failed to load ChatGPT status');
  }
});

router.delete('/admin/ai/codex', requireAdmin, async (_req, res) => {
  try {
    res.json(await disconnectCodex());
  } catch (error) {
    serviceError(res, error, 'Failed to disconnect ChatGPT');
  }
});

// ── Authenticated: AI status (used by compose & message pane) ─────────────────

router.get('/ai/status', requireAuth, async (_req, res) => {
  try {
    res.json(await getAiStatus());
  } catch (error) {
    serviceError(res, error, 'Failed to load AI status');
  }
});

function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return 'messages array is required';
  for (const message of messages) {
    if (!message?.role || typeof message.content !== 'string') return 'Each message must have role and content';
    if (!['system', 'user', 'assistant'].includes(message.role)) return 'Invalid message role';
    if (message.content.length > 32_000) return 'Message content exceeds maximum length';
  }
  return null;
}

// ── Authenticated: streaming chat proxy ───────────────────────────────────────

router.post('/ai/chat', requireAuth, async (req, res) => {
  const messages = req.body?.messages;
  const validationError = validateMessages(messages);
  if (validationError) return res.status(400).json({ error: validationError });

  let status;
  try {
    status = await getAiStatus();
  } catch (error) {
    return serviceError(res, error, 'Failed to load AI status');
  }
  if (!status.enabled) {
    const error = status.reconnectRequired
      ? 'AI provider requires reconnection'
      : 'AI provider is disabled or unavailable';
    return res.status(503).json({ error });
  }

  const controller = new AbortController();
  const abort = () => {
    if (!res.writableEnded && !controller.signal.aborted) controller.abort();
  };
  req.once('aborted', abort);
  res.once('close', abort);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  try {
    for await (const delta of streamChat(messages, { signal: controller.signal })) {
      if (controller.signal.aborted || res.destroyed) break;
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`);
    }
    if (!controller.signal.aborted && !res.destroyed) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
  } catch {
    if (!controller.signal.aborted && !res.destroyed) {
      res.write(`data: ${JSON.stringify({ error: 'AI request failed' })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  } finally {
    req.removeListener('aborted', abort);
    res.removeListener('close', abort);
  }
});

export default router;
