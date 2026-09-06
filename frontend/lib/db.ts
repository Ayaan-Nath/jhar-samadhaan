import { Pool } from 'pg';

/**
 * Shared node-postgres pool singleton.
 * DATABASE_URL must be set in the environment (see route-level error handling
 * for a friendly message when it is missing).
 */
const globalForDb = globalThis as unknown as { pgPool?: Pool };

export function getDbPool(): Pool {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL is not configured. Add it to the environment before calling the API.'
    );
  }
  const existing = globalForDb.pgPool;
  if (existing) return existing;

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
  });

  if (process.env.NODE_ENV !== 'production') globalForDb.pgPool = pool;
  return pool;
}
