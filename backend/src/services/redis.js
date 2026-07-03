import { createClient } from 'redis';

export const redisClient = createClient({ url: process.env.REDIS_URL || 'redis://redis:6379' });
redisClient.on('error', err => console.error('Redis error:', err));
