import { env, applyD1Migrations, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.exec('DELETE FROM votes');
});

async function seed(rows) {
  for (const r of rows) {
    await env.DB.prepare(
      `INSERT INTO votes (mini_code, voter_id, fingerprint, ip_hash, asn_name, created_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(r.mini_code, r.voter_id, r.fingerprint, r.ip_hash,
           r.asn_name || '', r.created_at || new Date().toISOString(),
           r.status || 'valid').run();
  }
}

describe('GET /admin/results', () => {
  it('deniega el acceso sin cabecera de Access', async () => {
    const res = await SELF.fetch('https://www.laorden.org/admin/results');
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).not.toContain('Recuento');
  });

  it('deniega el acceso con un JWT malformado', async () => {
    const res = await SELF.fetch('https://www.laorden.org/admin/results', {
      headers: { 'Cf-Access-Jwt-Assertion': 'esto.no.es-un-jwt' }
    });
    expect(res.status).toBe(403);
  });

  it('no filtra el recuento en el cuerpo de una respuesta denegada', async () => {
    await seed([{ mini_code: '07', voter_id: 'v1', fingerprint: 'f1', ip_hash: 'h1' }]);
    const res = await SELF.fetch('https://www.laorden.org/admin/results');
    const body = await res.text();
    expect(body).not.toContain('07');
  });

  it('la ruta de admin no la atiende el manejador de /api', async () => {
    const res = await SELF.fetch('https://www.laorden.org/admin/results');
    expect(res.headers.get('Content-Type') || '').not.toContain('application/json');
  });

  it('una subruta desconocida de /admin devuelve 404, no el recuento', async () => {
    const res = await SELF.fetch('https://www.laorden.org/admin/otra-cosa');
    expect(res.status).toBe(404);
  });
});
