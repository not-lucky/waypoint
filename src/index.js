import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { bootstrap } from './infrastructure/web/server.js';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await bootstrap();
}
