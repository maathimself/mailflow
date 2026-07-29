import { sanitizeFolderOrder } from '../utils/sidebar.js';

const STORAGE_KEY = 'mailflow_folder_order';

export function cacheFolderOrder(value, storage = localStorage) {
  const clean = sanitizeFolderOrder(value);
  storage.setItem(STORAGE_KEY, JSON.stringify(clean));
  return clean;
}

export function readFolderOrder(storage = localStorage) {
  try {
    return sanitizeFolderOrder(
      JSON.parse(storage.getItem(STORAGE_KEY) || '{}'),
    );
  } catch {
    return {};
  }
}

export function cacheFolderOrderFromPreferences(
  preferences,
  storage = localStorage,
) {
  return cacheFolderOrder(preferences?.folderOrder ?? {}, storage);
}

export function mergeFolderOrder(
  current,
  accountId,
  paths,
  storage = localStorage,
) {
  return cacheFolderOrder({
    ...sanitizeFolderOrder(current),
    [accountId]: Array.isArray(paths) ? paths : [],
  }, storage);
}
