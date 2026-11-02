import { mkdirSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildServer } from './server.ts';

const dataDir = process.env.PNEUMO_DATA_DIR ?? fileURLToPath(new URL('../data/', import.meta.url));
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '0.0.0.0';
mkdirSync(dataDir, { recursive: true });

const { app } = await buildServer({
  dbPath: join(dataDir, 'pneumoscreen.sqlite'),
  dataDir,
  logger: true,
  corsOrigins: process.env.PNEUMO_CORS_ORIGINS?.split(',').map((s) => s.trim()).filter(Boolean),
});
await app.listen({ port, host });

const lan = Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i!.address);
console.log(`\nPneumoScreen server on http://localhost:${port}`);
for (const ip of lan) console.log(`  on this network: http://${ip}:${port}`);
console.log(`  data: ${dataDir}\n`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void app.close().then(() => process.exit(0)));
