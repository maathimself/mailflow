const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const current = LEVELS[process.env.LOG_LEVEL?.toLowerCase()] ?? LEVELS.info;

export const logger = {
  debug: (...a) => current <= 0 && console.log('[debug]', ...a),
  info:  (...a) => current <= 1 && console.log('[info]',  ...a),
  warn:  (...a) => current <= 2 && console.warn('[warn]',  ...a),
  error: (...a) => current <= 3 && console.error('[error]', ...a),
};
