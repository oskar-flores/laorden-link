import { fileURLToPath } from 'node:url';
import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';

const migrationsPath = fileURLToPath(new URL('./migrations', import.meta.url));
const migrations = await readD1Migrations(migrationsPath);

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          d1Databases: ['DB'],
          bindings: {
            TEST_MIGRATIONS: migrations,
            IP_SALT: 'sal-de-pruebas',
            TURNSTILE_SECRET: 'secreto-de-pruebas'
          }
        }
      }
    }
  }
});
