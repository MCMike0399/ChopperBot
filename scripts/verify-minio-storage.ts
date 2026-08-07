// Verify the MinIO object-storage wiring end-to-end against the LIVE server:
// builds the backend from the same config the bot uses, checks the bucket,
// then runs a put → get → miss → delete round-trip on a probe object.
// Read-only in spirit: it writes one `workshop/_probe/` object and removes it.
//
// Usage:
//   npx tsx scripts/verify-minio-storage.ts
import 'dotenv/config';
import { config } from '../src/config.js';
import { createObjectStorage } from '../src/storage/index.js';

function fail(msg: string): never {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const storage = createObjectStorage();
  if (!storage) {
    fail('MINIO_ACCESS_KEY/MINIO_SECRET_KEY no están configurados — el storage está deshabilitado.');
  }
  console.log(`backend=${storage!.backend} endpoint=${config.MINIO_ENDPOINT} bucket=${config.MINIO_BUCKET}`);

  if (!(await storage!.ensureReady())) {
    fail('El bucket no existe y no pudo crearse (¿MinIO caído? ¿credenciales sin permiso?).');
  }
  console.log('bucket: OK');

  const key = `workshop/_probe/${Date.now()}.txt`;
  const payload = new TextEncoder().encode(`probe ${new Date().toISOString()}`);

  await storage!.put(key, payload, 'text/plain');
  const back = await storage!.get(key);
  if (!back || Buffer.from(back).toString('utf-8') !== Buffer.from(payload).toString('utf-8')) {
    fail('get no devolvió lo que put subió.');
  }
  console.log('put/get: OK');

  const miss = await storage!.get('workshop/_probe/este-archivo-no-existe');
  if (miss !== null) fail('una llave inexistente no devolvió null.');
  console.log('miss → null: OK');

  await storage!.delete(key);
  if ((await storage!.get(key)) !== null) fail('delete no eliminó el objeto.');
  console.log('delete: OK');

  storage!.destroy?.();
  console.log('✅ MinIO storage verificado.');
}

main().catch((err) => {
  console.error('❌', err instanceof Error ? err.message : err);
  process.exit(1);
});
