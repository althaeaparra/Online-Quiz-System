process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-test-access-secret';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-test-refresh-secret';
process.env.JWT_ACCESS_EXPIRES = '15m';
process.env.JWT_REFRESH_EXPIRES = '7d';
process.env.BCRYPT_ROUNDS = '4'; // keep hashing fast in tests
process.env.LOG_LEVEL = 'error';
process.env.UPLOAD_DIR = 'public/uploads';

// Rate limiting and Redis are disabled under NODE_ENV=test (see middleware/rateLimit.js
// and config/redis.js); everything else runs against a real, ephemeral MongoDB.
