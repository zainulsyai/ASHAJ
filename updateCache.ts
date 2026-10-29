import fs from 'fs';
import path from 'path';
import { generateInitialDatabase } from './src/services/dataStorage';

const db = generateInitialDatabase(false);
fs.writeFileSync(path.join(process.cwd(), 'server_database_cache.json'), JSON.stringify(db, null, 2), 'utf-8');
console.log('server_database_cache.json updated successfully with official transactions and rooms!');
