const Redis = require('ioredis');
require('dotenv').config();

const redisConfig = {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: process.env.REDIS_PORT || 6379,
    password: process.env.REDIS_PASSWORD || null,
    retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
    },
};

const redis = new Redis(redisConfig);

redis.on('connect', () => {
    console.log('✅ Redis: Connected successfully');
});

redis.on('error', (err) => {
    console.error('❌ Redis: Connection error:', err.message);
});

module.exports = {
    redis,
    redisConfig
};
