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
            TURNSTILE_SECRET: 'secreto-de-pruebas',
            ALLOW_TEST_CLOCK: 'yes',
            // Con valores no vacíos, verifyAccessJwt ya no corta en la guarda
            // de "no configurado" y admin.test.js puede ejercer de verdad
            // jwtVerify, la comprobación de issuer/audience y el catch.
            ACCESS_TEAM_DOMAIN: 'equipo-de-pruebas.cloudflareaccess.com',
            ACCESS_AUD: 'aud-de-pruebas'
          }
        }
      }
    }
  }
});
