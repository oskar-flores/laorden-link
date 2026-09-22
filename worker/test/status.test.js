import { env, applyD1Migrations, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.exec('DELETE FROM votes');
});

async function insertVote(overrides = {}) {
  const v = {
    mini_code: '07', voter_id: 'votante-1', fingerprint: 'huella-1',
    ip_hash: 'hash-1', created_at: new Date().toISOString(), status: 'valid',
    ...overrides
  };
  await env.DB.prepare(
    `INSERT INTO votes (mini_code, voter_id, fingerprint, ip_hash, created_at, status)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(v.mini_code, v.voter_id, v.fingerprint, v.ip_hash, v.created_at, v.status).run();
}

describe('GET /api/status', () => {
  it('devuelve la ventana configurada', async () => {
    const res = await SELF.fetch('https://www.laorden.org/api/status');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.opens_at).toBe('2026-10-11T10:00:00+02:00');
    expect(body.closes_at).toBe('2026-10-17T12:00:00+02:00');
    expect(typeof body.open).toBe('boolean');
  });

  it('has_voted es false sin cookie', async () => {
    const res = await SELF.fetch('https://www.laorden.org/api/status');
    expect((await res.json()).has_voted).toBe(false);
  });

  it('has_voted es true si la cookie tiene un voto válido', async () => {
    await insertVote({ voter_id: 'votante-1' });
    const res = await SELF.fetch('https://www.laorden.org/api/status', {
      headers: { Cookie: 'voter_id=votante-1' }
    });
    expect((await res.json()).has_voted).toBe(true);
  });

  it('has_voted vuelve a false si el voto fue anulado', async () => {
    await insertVote({ voter_id: 'votante-1', status: 'annulled' });
    const res = await SELF.fetch('https://www.laorden.org/api/status', {
      headers: { Cookie: 'voter_id=votante-1' }
    });
    expect((await res.json()).has_voted).toBe(false);
  });

  it('nunca revela a quién se votó (resultados sellados, §3)', async () => {
    await insertVote({ voter_id: 'votante-1', mini_code: 'FUGA-99', status: 'valid' });
    const res = await SELF.fetch('https://www.laorden.org/api/status', {
      headers: { Cookie: 'voter_id=votante-1' }
    });
    const body = await res.json();

    // Lista blanca positiva: cualquier campo nuevo, se llame como se llame,
    // rompe este test hasta que alguien actualice la lista deliberadamente.
    expect(Object.keys(body).sort()).toEqual(
      ['closes_at', 'has_voted', 'open', 'opens_at', 'state']
    );

    // Comprobaciones adicionales, baratas, que no sustituyen a la de arriba.
    expect(body).not.toHaveProperty('voted_for');
    expect(JSON.stringify(body)).not.toContain('FUGA-99');
  });

  it('no se cachea', async () => {
    const res = await SELF.fetch('https://www.laorden.org/api/status');
    expect(res.headers.get('Cache-Control')).toContain('no-store');
  });

  it('una ruta desconocida devuelve 404', async () => {
    const res = await SELF.fetch('https://www.laorden.org/api/loquesea');
    expect(res.status).toBe(404);
  });
});
