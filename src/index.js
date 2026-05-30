import 'dotenv/config';
import { bootstrap } from './app/bootstrap.js';

const { app, server, keyRegistry } = await bootstrap();

export { app, server, keyRegistry };
