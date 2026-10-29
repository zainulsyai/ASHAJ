import pkg from 'pg';
const { Pool } = pkg;

// Mengambil DATABASE_URL dari environment variable (Aiven PostgreSQL)
// Jika belum disiapkan, default ke string kosong atau lokal untuk mencegah crash saat start
const connectionString = process.env.DATABASE_URL || '';

export const pool = new Pool({
  connectionString: connectionString || undefined,
  ssl: {
    rejectUnauthorized: false,
  },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client:', err);
});

export async function query(text: string, params?: any[]) {
  if (!connectionString) {
    throw new Error('DATABASE_URL belum dikonfigurasi. Harap tentukan DATABASE_URL Aiven PostgreSQL di .env');
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
