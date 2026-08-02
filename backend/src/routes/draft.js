import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { imapManager } from '../index.js';
import { query } from '../services/db.js';
import { deleteDraft, saveDraft } from '../services/draftService.js';

const router = Router();
router.use(requireAuth);

router.post('/draft', async (req, res) => {
  const {
    accountId,
    aliasId,
    to,
    cc,
    bcc,
    subject,
    body,
    bodyIsHtml = false,
    quotedBody,
    quotedBodyHtml,
    editedSignature,
    inReplyTo,
    references,
    existingUid,
    existingFolder,
  } = req.body;
  if (!accountId) return res.status(400).json({ error: 'accountId required' });

  const accountResult = await query(
    'SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2',
    [accountId, req.session.userId],
  );
  if (!accountResult.rows.length) return res.status(404).json({ error: 'Account not found' });

  try {
    const result = await saveDraft({
      userId: req.session.userId,
      account: accountResult.rows[0],
      aliasId,
      to,
      cc,
      bcc,
      subject,
      body,
      bodyIsHtml,
      quotedBody,
      quotedBodyHtml,
      editedSignature,
      inReplyTo,
      references,
      existingUid,
      existingFolder,
    }, { query, imapManager });
    return res.json({ uid: result.uid, folder: result.folder });
  } catch (err) {
    console.error('Save draft failed:', err.message);
    const response = { error: err.message || 'Failed to save draft' };
    if (err.code === 'alias_not_found') response.code = err.code;
    return res.status(err.status || 500).json(response);
  }
});

router.delete('/draft/:uid', async (req, res) => {
  const uid = parseInt(req.params.uid, 10);
  if (!uid || !Number.isFinite(uid)) return res.status(400).json({ error: 'Invalid uid' });

  const { accountId, folder } = req.query;
  if (!accountId || !folder) {
    return res.status(400).json({ error: 'accountId and folder required' });
  }

  const accountResult = await query(
    'SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2',
    [accountId, req.session.userId],
  );
  if (!accountResult.rows.length) return res.status(404).json({ error: 'Account not found' });

  try {
    const result = await deleteDraft({
      userId: req.session.userId,
      account: accountResult.rows[0],
      uid,
      folder,
    }, { query, imapManager });
    return res.json(result);
  } catch (err) {
    console.error('Delete draft failed:', err.message);
    return res.status(500).json({ error: err.message || 'Failed to delete draft' });
  }
});

export default router;
