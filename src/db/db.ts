import pkg from 'pg';
const { Pool } = pkg;

let currentPool: any = null;

function isValidPostgresUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim();
  return trimmed.startsWith('postgres://') || trimmed.startsWith('postgresql://');
}

export function getPool() {
  const connectionString = (process.env.DATABASE_URL || '').trim();
  if (!isValidPostgresUrl(connectionString)) {
    return null;
  }
  if (!currentPool) {
    currentPool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      max: 5,                  // Dibatasi max 5 koneksi untuk plan Aiven free/small
      idleTimeoutMillis: 30000, // Putus koneksi menganggur setelah 30 detik
      connectionTimeoutMillis: 30000, // 30 detik timeout untuk mencegah timeout exceeded
    });
    currentPool.on('error', (err: any) => {
      console.error('Unexpected error on idle PostgreSQL client:', err);
    });
  }
  return currentPool;
}

export async function query(text: string, params?: any[]) {
  const connectionString = (process.env.DATABASE_URL || '').trim();
  if (!isValidPostgresUrl(connectionString)) {
    throw new Error('DATABASE_URL belum dikonfigurasi atau tidak valid. Harap tentukan DATABASE_URL Aiven PostgreSQL (postgres://...) di .env atau melalui panel Aiven.');
  }
  let pool = getPool();
  if (!pool) {
    currentPool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 30000,
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
    client.release(); // PENTING: Wajib melepas koneksi agar slot tidak habis!
  }
}

export function updatePoolConfig(newUrl: string) {
  process.env.DATABASE_URL = newUrl;
  if (currentPool) {
    currentPool.end().catch(() => {});
    currentPool = null;
  }
}
