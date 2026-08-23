process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
process.env.JWT_ACCESS_SECRET = "a".repeat(32);
process.env.JWT_REFRESH_SECRET = "b".repeat(32);
process.env.NODE_ENV = "test";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_123";
process.env.CORS_ORIGIN = "http://localhost";
