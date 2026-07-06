import { createClient } from 'redis';

// The redis v4 client's parseURL only accepts redis:// and rediss:// schemes.
// Unix socket connections require socket: { path } instead of a URL.
// This helper routes socket URIs (redis+unix://, unix://, redis+socket://)
// and bare absolute paths to socket.path; everything else passes through as-is.
function redisOptions(rawUrl) {
  if (!rawUrl) return { url: 'redis://redis:6379' };
  const socketSchemes = ['redis+unix://', 'unix://', 'redis+socket://'];
  if (rawUrl.startsWith('/') || socketSchemes.some(s => rawUrl.startsWith(s))) {
    return { socket: { path: rawUrl.replace(/^[^/]*:\/\//, '') } };
  }
  return { url: rawUrl };
}

export const redisClient = createClient(redisOptions(process.env.REDIS_URL));
redisClient.on('error', err => console.error('Redis error:', err));
