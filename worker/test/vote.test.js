import { env, applyD1Migrations, SELF, fetchMock } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterEach, beforeEach } from 'vitest';
import { handleVote } from '../src/routes/vote.js';
import { hashIp } from '../src/lib/crypto.js';

// Debe coincidir con IP_SALT en vitest.config.js.
const IP_SALT_DE_PRUEBAS = 'sal-de-pruebas';

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

/** Petición cruda, para llamar a handleVote directamente con un env alterado. */
function peticionVoto(body, { cookie, ip = '81.0.0.1', now = DURANTE } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'CF-Connecting-IP': ip,
    'X-Test-Now': now.toISOString()
  };
  if (cookie) headers.Cookie = cookie;
  return new Request('https://www.laorden.org/api/vote', {
    method: 'POST', headers, body: JSON.stringify(body)
  });
}

/** Inserta filas de votos directamente, sin pasar por /api/vote. */
async function seedVotes(rows) {
  const stmt = env.DB.prepare(
    `INSERT INTO votes (mini_code, voter_id, fingerprint, ip_hash, created_at, status)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  await env.DB.batch(rows.map((r) => stmt.bind(
    r.mini_code || '07', r.voter_id, r.fingerprint, r.ip_hash,
    r.created_at || new Date().toISOString(), r.status || 'valid'
  )));
}

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

  it('acepta un voto sin huella — el bloqueador mató el CDN de FingerprintJS', async () => {
    mockTurnstile(true);
    const res = await vote({ ...VALIDO, fingerprint: '' });
    expect(res.status).toBe(200);
    expect((await res.json()).message).toBe('¡Gracias! Tu voto se ha registrado.');

    const { results } = await env.DB.prepare('SELECT * FROM votes').all();
    expect(results).toHaveLength(1);
    expect(results[0].fingerprint).toBe('');
  });

  it('dos votantes distintos sin huella votan los dos (el índice único la excluye)', async () => {
    // La prueba que cuenta: si idx_votes_fp no excluyese la huella vacía, el
    // primer votante con el CDN bloqueado dejaría fuera a todos los demás.
    mockTurnstile(true);
    const uno = await vote({ ...VALIDO, fingerprint: '' }, { cookie: 'voter_id=votante-uno' });
    expect(uno.status).toBe(200);

    mockTurnstile(true);
    const dos = await vote({ ...VALIDO, mini_code: '12', fingerprint: '' },
                           { cookie: 'voter_id=votante-dos' });
    expect(dos.status).toBe(200);
    expect((await dos.json()).message).toBe('¡Gracias! Tu voto se ha registrado.');

    const { results } = await env.DB.prepare("SELECT * FROM votes WHERE status='valid'").all();
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.voter_id).sort()).toEqual(['votante-dos', 'votante-uno']);
  });

  it('sigue rechazando un segundo voto sin huella con la misma cookie (409)', async () => {
    mockTurnstile(true);
    const uno = await vote({ ...VALIDO, fingerprint: '' }, { cookie: 'voter_id=votante-uno' });
    expect(uno.status).toBe(200);

    mockTurnstile(true);
    const dos = await vote({ ...VALIDO, fingerprint: '' }, { cookie: 'voter_id=votante-uno' });
    expect(dos.status).toBe(409);

    const { results } = await env.DB.prepare("SELECT * FROM votes WHERE status='valid'").all();
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

  it('rechaza un cuerpo JSON `null` (400)', async () => {
    const res = await vote(null);
    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe('Obra no válida.');
  });

  it('rechaza un cuerpo JSON que no es un objeto (400)', async () => {
    const res = await vote(123);
    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe('Obra no válida.');
  });

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

  it('ya no corta a un votante 21 de la misma IP — el CGNAT de una operadora no debe bloquear', async () => {
    // El límite antiguo (20) haría esto un 429; con el nuevo (200) un puñado
    // de votantes legítimos detrás del mismo CGNAT vota sin problema.
    const ip = '81.0.0.9';
    const ipHash = await hashIp(ip, IP_SALT_DE_PRUEBAS);
    const filas = [];
    for (let i = 0; i < 50; i++) {
      filas.push({ voter_id: `votante-cgnat-${i}`, fingerprint: `huella-cgnat-${i}`, ip_hash: ipHash });
    }
    await seedVotes(filas);

    mockTurnstile(true);
    const res = await vote({ ...VALIDO, fingerprint: 'huella-cgnat-51' }, { ip });
    expect(res.status).toBe(200);
    expect((await res.json()).message).toBe('¡Gracias! Tu voto se ha registrado.');
  });

  it('corta por abuso a partir de 200 votos VÁLIDOS del mismo hash de IP (429)', async () => {
    const ip = '81.0.0.9';
    const ipHash = await hashIp(ip, IP_SALT_DE_PRUEBAS);
    const filas = [];
    for (let i = 0; i < 200; i++) {
      filas.push({ voter_id: `votante-abuso-${i}`, fingerprint: `huella-abuso-${i}`, ip_hash: ipHash });
    }
    await seedVotes(filas);

    mockTurnstile(true);
    const res = await vote({ ...VALIDO, fingerprint: 'huella-desbordante' }, { ip });
    expect(res.status).toBe(429);
    expect((await res.json()).message).toBe('Demasiados intentos. Inténtalo más tarde.');
  });

  it('los votos anulados no cuentan para el cortafuegos de abuso (§10 devuelve el cupo)', async () => {
    const ip = '81.0.0.10';
    const ipHash = await hashIp(ip, IP_SALT_DE_PRUEBAS);
    const filas = [];
    for (let i = 0; i < 200; i++) {
      filas.push({
        voter_id: `votante-anulado-${i}`, fingerprint: `huella-anulada-${i}`,
        ip_hash: ipHash, status: 'annulled'
      });
    }
    await seedVotes(filas);

    mockTurnstile(true);
    const res = await vote({ ...VALIDO, fingerprint: 'huella-tras-anulacion' }, { ip });
    expect(res.status).toBe(200);
    expect((await res.json()).message).toBe('¡Gracias! Tu voto se ha registrado.');
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

describe('IP_SALT — falla cerrado si no es utilizable (G1)', () => {
  // Se llama a handleVote directamente (en vez de por SELF.fetch) para poder
  // alterar env.IP_SALT en una sola petición sin tocar los bindings globales
  // de vitest.config.js, de los que depende el resto de la suite.

  it('rechaza el voto si IP_SALT no está definido (500, mensaje neutro)', async () => {
    const req = peticionVoto(VALIDO);
    const res = await handleVote(req, { ...env, IP_SALT: undefined });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.message).toBe('No hemos podido registrar tu voto. Inténtalo de nuevo más tarde.');
    // El mensaje no debe delatar el motivo real al público.
    expect(body.message.toLowerCase()).not.toMatch(/sal|salt|config/);

    const { results } = await env.DB.prepare('SELECT * FROM votes').all();
    expect(results).toHaveLength(0);
  });

  it('rechaza el voto si IP_SALT es la cadena vacía (500)', async () => {
    const req = peticionVoto(VALIDO);
    const res = await handleVote(req, { ...env, IP_SALT: '' });
    expect(res.status).toBe(500);
    const { results } = await env.DB.prepare('SELECT * FROM votes').all();
    expect(results).toHaveLength(0);
  });

  it('rechaza el voto si IP_SALT es más corto que el mínimo (500)', async () => {
    const req = peticionVoto(VALIDO);
    const res = await handleVote(req, { ...env, IP_SALT: 'corta' });
    expect(res.status).toBe(500);
    const { results } = await env.DB.prepare('SELECT * FROM votes').all();
    expect(results).toHaveLength(0);
  });

  it('con el IP_SALT de pruebas (14 caracteres) el voto se registra con normalidad', async () => {
    mockTurnstile(true);
    const req = peticionVoto(VALIDO);
    const res = await handleVote(req, env);
    expect(res.status).toBe(200);
    const { results } = await env.DB.prepare('SELECT * FROM votes').all();
    expect(results).toHaveLength(1);
  });
});
