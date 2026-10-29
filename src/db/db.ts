import pkg from 'pg';
const { Pool } = pkg;

let currentPool: any = null;

export function getPool() {
  const connectionString = process.env.DATABASE_URL || '';
  if (!currentPool && connectionString) {
    currentPool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
    currentPool.on('error', (err: any) => {
      console.error('Unexpected error on idle PostgreSQL client:', err);
    });
  }
  return currentPool;
}

export async function query(text: string, params?: any[]) {
  const connectionString = process.env.DATABASE_URL || '';
  if (!connectionString) {
    throw new Error('DATABASE_URL belum dikonfigurasi. Harap tentukan DATABASE_URL Aiven PostgreSQL di .env atau melalui panel Aiven.');
  }
  let pool = getPool();
  if (!pool) {
    currentPool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
    pool = currentPool;
  }
  const client = await pool.connect();
  try {
    const start = Date.now();
    const res = await client.query(text, params);
    const duration = Date.now() - start;
    console.log('Executed query', { text: text.substring(0, 50), duration, rows: res.rowCount });
    return res;
  } finally {
    client.release();
  }
}

export function updatePoolConfig(newUrl: string) {
  process.env.DATABASE_URL = newUrl;
  if (currentPool) {
    currentPool.end().catch(() => {});
    currentPool = null;
  }
}
