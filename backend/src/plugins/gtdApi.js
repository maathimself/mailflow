// Trusted, bundled-GTD annotation capabilities. These wrappers bind the namespace in core so the
// sandboxed plugin API never accepts a caller-supplied plugin id or exposes another plugin's data.
import {
  getAnnotatedThreadKeysMissingFolder as _getAnnotatedThreadKeysMissingFolder,
  getMessageAnnotations as _getMessageAnnotations,
  getThreadAnnotationRows as _getThreadAnnotationRows,
  setMessageAnnotation as _setMessageAnnotation,
  setThreadAnnotation as _setThreadAnnotation,
} from '../services/mailAccess.js';

const PLUGIN_ID = 'gtd';

export const getMessageAnnotations = (accountId, ids) => (
  _getMessageAnnotations(accountId, ids, PLUGIN_ID)
);

export const setMessageAnnotation = (accountId, messageId, patch) => (
  _setMessageAnnotation(accountId, messageId, PLUGIN_ID, patch)
);

export const getAnnotatedThreadKeysMissingFolder = (accountId, folder, key) => (
  _getAnnotatedThreadKeysMissingFolder(accountId, folder, PLUGIN_ID, key)
);

export const getThreadAnnotationRows = (accountId, threadKeys) => (
  _getThreadAnnotationRows(accountId, threadKeys)
);

export const setThreadAnnotation = (accountId, threadKey, key, value) => (
  _setThreadAnnotation(accountId, threadKey, PLUGIN_ID, key, value)
);
