import { env, applyD1Migrations, SELF, fetchMock } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterEach, beforeEach } from 'vitest';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

beforeEach(async () => {
  await env.DB.exec('DELETE FROM votes');
});

/** Intercepta una llamada a Turnstile con el resultado indicado. */
function mockTurnstile(success = true) {
  fetchMock
    .get('https://challenges.cloudflare.com')
    .intercept({ path: '/turnstile/v0/siteverify', method: 'POST' })
    .reply(200, { success });
}

const DURANTE = new Date('2026-10-14T12:00:00+02:00');
const ANTES   = new Date('2026-10-01T12:00:00+02:00');
const DESPUES = new Date('2026-10-18T12:00:00+02:00');

function vote(body, { cookie, ip = '81.0.0.1', now = DURANTE } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'CF-Connecting-IP': ip,
    'X-Test-Now': now.toISOString()
  };
  if (cookie) headers.Cookie = cookie;
  return SELF.fetch('https://www.laorden.org/api/vote', {
    method: 'POST', headers, body: JSON.stringify(body)
  });
}

const VALIDO = { mini_code: '07', fingerprint: 'huella-a', turnstile_token: 'tok' };

describe('POST /api/vote', () => {
  it('registra un voto válido dentro de la ventana', async () => {
    mockTurnstile(true);
    const res = await vote(VALIDO);
    expect(res.status).toBe(200);
    expect((await res.json()).message).toBe('¡Gracias! Tu voto se ha registrado.');

    const { results } = await env.DB.prepare('SELECT * FROM votes').all();
    expect(results).toHaveLength(1);
    expect(results[0].mini_code).toBe('07');
    expect(results[0].status).toBe('valid');
  });

  it('emite la cookie con las banderas correctas', async () => {
    mockTurnstile(true);
    const res = await vote(VALIDO);
    const cookie = res.headers.get('Set-Cookie');
    expect(cookie).toContain('voter_id=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=2592000');
  });

  it('rechaza un segundo voto con la misma cookie (409)', async () => {
    mockTurnstile(true);
    const first = await vote(VALIDO);
    const voterId = first.headers.get('Set-Cookie').match(/voter_id=([^;]+)/)[1];

    mockTurnstile(true);
    const res = await vote({ ...VALIDO, fingerprint: 'huella-distinta' },
                           { cookie: `voter_id=${voterId}` });
    expect(res.status).toBe(409);
    expect((await res.json()).message).toBe('Ya se ha registrado un voto desde este dispositivo.');

    const { results } = await env.DB.prepare('SELECT * FROM votes').all();
    expect(results).toHaveLength(1);
  });

  it('rechaza la misma huella sin cookie — incógnito no sirve (409)', async () => {
    mockTurnstile(true);
    await vote(VALIDO);
    mockTurnstile(true);
    const res = await vote(VALIDO);   // misma huella, sin cookie
    expect(res.status).toBe(409);
    const { results } = await env.DB.prepare('SELECT * FROM votes').all();
    expect(results).toHaveLength(1);
  });

  it('rechaza antes de la apertura (403)', async () => {
    const res = await vote(VALIDO, { now: ANTES });
    expect(res.status).toBe(403);
    expect((await res.json()).message).toBe('La votación no está abierta.');
  });

  it('rechaza después del cierre (403)', async () => {
    const res = await vote(VALIDO, { now: DESPUES });
    expect(res.status).toBe(403);
  });

  it('rechaza si Turnstile falla (403)', async () => {
    mockTurnstile(false);
    const res = await vote(VALIDO);
    expect(res.status).toBe(403);
    expect((await res.json()).message).toBe('No hemos podido verificar que eres una persona.');
    const { results } = await env.DB.prepare('SELECT * FROM votes').all();
    expect(results).toHaveLength(0);
  });

  it.each(['00', '23', 'abc', '1', '007', '', null])(
    'rechaza el código de obra %p (400)', async (codigo) => {
      const res = await vote({ ...VALIDO, mini_code: codigo });
      expect(res.status).toBe(400);
      expect((await res.json()).message).toBe('Obra no válida.');
    }
  );

  it('no guarda nunca la IP en claro (§12)', async () => {
    mockTurnstile(true);
    await vote(VALIDO, { ip: '81.44.123.45' });
    const { results } = await env.DB.prepare('SELECT * FROM votes').all();
    expect(JSON.stringify(results)).not.toContain('81.44.123.45');
    expect(results[0].ip_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('permite volver a votar si el voto anterior fue anulado', async () => {
    mockTurnstile(true);
    const first = await vote(VALIDO);
    const voterId = first.headers.get('Set-Cookie').match(/voter_id=([^;]+)/)[1];
    await env.DB.exec("UPDATE votes SET status = 'annulled'");

    mockTurnstile(true);
    const res = await vote(VALIDO, { cookie: `voter_id=${voterId}` });
    expect(res.status).toBe(200);
    const { results } = await env.DB.prepare("SELECT * FROM votes WHERE status='valid'").all();
    expect(results).toHaveLength(1);
  });

  it('corta por abuso a partir de 20 votos del mismo hash de IP (429)', async () => {
    for (let i = 0; i < 20; i++) {
      mockTurnstile(true);
      const r = await vote({ ...VALIDO, fingerprint: `huella-${i}` }, { ip: '81.0.0.9' });
      expect(r.status).toBe(200);
    }
    mockTurnstile(true);
    const res = await vote({ ...VALIDO, fingerprint: 'huella-21' }, { ip: '81.0.0.9' });
    expect(res.status).toBe(429);
    expect((await res.json()).message).toBe('Demasiados intentos. Inténtalo más tarde.');
  });

  it('guarda asn y asn_name cuando el objeto cf los trae', async () => {
    mockTurnstile(true);
    await vote(VALIDO);
    const row = await env.DB.prepare('SELECT asn, asn_name FROM votes').first();
    expect(row).toHaveProperty('asn');
    expect(row).toHaveProperty('asn_name');
  });

  it('no rompe si el objeto cf no existe (desarrollo local)', async () => {
    mockTurnstile(true);
    const res = await vote(VALIDO);
    expect(res.status).toBe(200);
    const row = await env.DB.prepare('SELECT asn, asn_name, country FROM votes').first();
    expect(row.asn_name).toBe('');
    expect(row.country).toBe('');
  });

  it('dos peticiones simultáneas con la misma huella dejan una sola fila', async () => {
    // Esto comprueba la afirmación central del §6: el índice único parcial es
    // lo que resuelve la carrera, no el código de la aplicación.
    mockTurnstile(true);
    mockTurnstile(true);
    const [a, b] = await Promise.all([
      vote({ ...VALIDO, fingerprint: 'huella-carrera' }),
      vote({ ...VALIDO, fingerprint: 'huella-carrera' })
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const { results } = await env.DB.prepare("SELECT * FROM votes WHERE status='valid'").all();
    expect(results).toHaveLength(1);
  });

  it('rechaza GET en la ruta de voto', async () => {
    const res = await SELF.fetch('https://www.laorden.org/api/vote');
    expect(res.status).toBe(404);
  });
});
