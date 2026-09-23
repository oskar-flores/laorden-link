import { env, applyD1Migrations, SELF, fetchMock } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterEach, beforeEach } from 'vitest';
import { handleCode } from '../src/routes/code.js';
import { hashCodigo, generarCodigo } from '../src/lib/codigos.js';

const IP_SALT_DE_PRUEBAS = 'sal-de-pruebas';   // debe coincidir con vitest.config.js
const DURANTE = new Date('2026-10-14T12:00:00+02:00');

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

beforeEach(async () => {
  await env.DB.exec('DELETE FROM votes');
  await env.DB.exec('DELETE FROM codigos');
});

function mockTurnstile(success = true) {
  fetchMock
    .get('https://challenges.cloudflare.com')
    .intercept({ path: '/turnstile/v0/siteverify', method: 'POST' })
    .reply(200, { success });
}

/** Doble del binding de correo. Ninguna prueba manda correo de verdad. */
function espia({ falla = false } = {}) {
  const enviados = [];
  return {
    enviados,
    send: async (m) => { if (falla) throw new Error('no'); enviados.push(m); return { messageId: 'x' }; }
  };
}

const VARS = {
  EMAIL_REMITENTE: 'votacion@laorden.org',
  CODIGO_MINUTOS: '10',
  CODIGOS_POR_HORA: '3',
  MAX_CORREOS_DIA: '400'
};

function peticion(body, { ip = '81.0.0.1', now = DURANTE } = {}) {
  return new Request('https://www.laorden.org/api/code', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': ip,
      'X-Test-Now': now.toISOString()
    },
    body: JSON.stringify(body)
  });
}

/** Llama a la ruta con un env al que se le ha enchufado el doble de correo. */
function pedirCodigo(body, opciones = {}, extraEnv = {}) {
  const EMAIL = opciones.EMAIL || espia();
  const respuesta = handleCode(peticion(body, opciones), { ...env, ...VARS, EMAIL, ...extraEnv });
  return respuesta.then((res) => ({ res, EMAIL }));
}

const VALIDO = { correo: 'fulano@gmail.com', turnstile_token: 'tok' };
const ENVIADO = 'Si la dirección es correcta, te hemos enviado un código.';
const FALLO = 'No hemos podido enviarte el código. Escribe a laordenaslu@gmail.com y te ayudamos a votar.';

describe('POST /api/code', () => {
  it('manda un código y guarda la fila, sin el código en claro', async () => {
    mockTurnstile(true);
    const { res, EMAIL } = await pedirCodigo(VALIDO);
    expect(res.status).toBe(200);
    expect((await res.json()).message).toBe(ENVIADO);
    expect(EMAIL.enviados).toHaveLength(1);

    const fila = await env.DB.prepare('SELECT * FROM codigos').first();
    expect(fila.email_norm).toBe('fulano@gmail.com');
    expect(fila.usado_en).toBe(null);
    expect(fila.intentos).toBe(0);
    expect(fila.codigo_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(fila.ip_hash).toMatch(/^[0-9a-f]{64}$/);

    // El código viaja al buzón, nunca a la base.
    const enviado = EMAIL.enviados[0].text.match(/\b(\d{6})\b/)[1];
    expect(JSON.stringify(fila)).not.toContain(enviado);
    expect(fila.codigo_hash).toBe(await hashCodigo(IP_SALT_DE_PRUEBAS, 'fulano@gmail.com', enviado));
  });

  it('normaliza la dirección para la fila, pero manda al correo tal cual se escribió', async () => {
    mockTurnstile(true);
    const { res, EMAIL } = await pedirCodigo({ ...VALIDO, correo: 'Fulano.Perez+x@Gmail.com' });
    expect(res.status).toBe(200);
    expect(EMAIL.enviados[0].to).toBe('Fulano.Perez+x@Gmail.com');
    const fila = await env.DB.prepare('SELECT email_norm FROM codigos').first();
    expect(fila.email_norm).toBe('fulanoperez@gmail.com');
  });

  it('rechaza si Turnstile falla (403) y no manda nada', async () => {
    mockTurnstile(false);
    const { res, EMAIL } = await pedirCodigo(VALIDO);
    expect(res.status).toBe(403);
    expect((await res.json()).message).toBe('No hemos podido verificar que eres una persona.');
    expect(EMAIL.enviados).toHaveLength(0);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM codigos').first()).n).toBe(0);
  });

  it('Turnstile va ANTES que cualquier lectura de la base', async () => {
    // Un correo mal formado con Turnstile roto debe morir en el 403, no en el 400:
    // el resto de capas son lecturas de base que no hay que servirle a un bot.
    mockTurnstile(false);
    const { res } = await pedirCodigo({ correo: 'nada', turnstile_token: 'tok' });
    expect(res.status).toBe(403);
  });

  it.each(['', 'sin-arroba', 'a@b', 'dos@@arrobas.com', null, 1234, 'a'.repeat(250) + '@ejemplo.com'])(
    'rechaza la dirección %p (400)', async (correo) => {
      mockTurnstile(true);
      const { res, EMAIL } = await pedirCodigo({ correo, turnstile_token: 'tok' });
      expect(res.status).toBe(400);
      expect((await res.json()).message).toBe('Escribe una dirección de correo válida.');
      expect(EMAIL.enviados).toHaveLength(0);
    }
  );

  it('corta a la cuarta petición de la misma dirección en una hora (429)', async () => {
    for (let i = 0; i < 3; i++) {
      mockTurnstile(true);
      const { res } = await pedirCodigo(VALIDO);
      expect(res.status).toBe(200);
    }
    mockTurnstile(true);
    const { res, EMAIL } = await pedirCodigo(VALIDO);
    expect(res.status).toBe(429);
    expect((await res.json()).message)
      .toBe('Has pedido demasiados códigos. Espera una hora e inténtalo de nuevo.');
    expect(EMAIL.enviados).toHaveLength(0);
  });

  it('el límite por dirección es por HORA, no para siempre', async () => {
    const hace2h = new Date(Date.now() - 2 * 3600_000).toISOString();
    const stmt = env.DB.prepare(
      `INSERT INTO codigos (email_norm, codigo_hash, expira_en, ip_hash, created_at)
       VALUES ('fulano@gmail.com', 'h', ?, 'i', ?)`);
    for (let i = 0; i < 3; i++) await stmt.bind(hace2h, hace2h).run();

    mockTurnstile(true);
    const { res } = await pedirCodigo(VALIDO);
    expect(res.status).toBe(200);
  });

  it('corta a la petición 21 del mismo ip_hash en una hora (429)', async () => {
    const stmt = env.DB.prepare(
      `INSERT INTO codigos (email_norm, codigo_hash, expira_en, ip_hash, created_at)
       VALUES (?, 'h', ?, ?, ?)`);
    const { hashIp } = await import('../src/lib/crypto.js');
    const ipHash = await hashIp('81.0.0.7', IP_SALT_DE_PRUEBAS);
    const ahora = new Date().toISOString();
    for (let i = 0; i < 20; i++) await stmt.bind(`otro-${i}@ejemplo.com`, ahora, ipHash, ahora).run();

    mockTurnstile(true);
    const { res, EMAIL } = await pedirCodigo(VALIDO, { ip: '81.0.0.7' });
    expect(res.status).toBe(429);
    expect(EMAIL.enviados).toHaveLength(0);
  });

  it('con el techo diario alcanzado contesta el mensaje neutro y no manda', async () => {
    const ahora = new Date().toISOString();
    const stmt = env.DB.prepare(
      `INSERT INTO codigos (email_norm, codigo_hash, expira_en, ip_hash, created_at)
       VALUES (?, 'h', ?, 'i', ?)`);
    for (let i = 0; i < 5; i++) await stmt.bind(`x${i}@ejemplo.com`, ahora, ahora).run();

    mockTurnstile(true);
    const { res, EMAIL } = await pedirCodigo(VALIDO, {}, { MAX_CORREOS_DIA: '5' });
    expect(res.status).toBe(503);
    const cuerpo = await res.json();
    expect(cuerpo.message).toBe(FALLO);
    // Nunca se dice "cuota": ni es problema del votante, ni se le cuenta al atacante.
    expect(cuerpo.message.toLowerCase()).not.toMatch(/cuota|l[íi]mite|quota/);
    expect(EMAIL.enviados).toHaveLength(0);
  });

  it('si la dirección YA ha votado contesta lo mismo y no manda nada (§5)', async () => {
    await env.DB.prepare(
      `INSERT INTO votes (mini_code, voter_id, ip_hash, created_at, status, email, email_norm)
       VALUES ('07', 'v1', 'h', ?, 'valid', 'Fulano@Gmail.com', 'fulano@gmail.com')`
    ).bind(new Date().toISOString()).run();

    mockTurnstile(true);
    const { res, EMAIL } = await pedirCodigo(VALIDO);
    expect(res.status).toBe(200);
    // Decir "ya has votado" aquí dejaría sondear direcciones ajenas.
    expect((await res.json()).message).toBe(ENVIADO);
    expect(EMAIL.enviados).toHaveLength(0);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM codigos').first()).n).toBe(0);
  });

  it('un voto anulado libera la dirección: vuelve a mandar código', async () => {
    await env.DB.prepare(
      `INSERT INTO votes (mini_code, voter_id, ip_hash, created_at, status, email, email_norm)
       VALUES ('07', 'v1', 'h', ?, 'annulled', 'Fulano@Gmail.com', 'fulano@gmail.com')`
    ).bind(new Date().toISOString()).run();

    mockTurnstile(true);
    const { res, EMAIL } = await pedirCodigo(VALIDO);
    expect(res.status).toBe(200);
    expect(EMAIL.enviados).toHaveLength(1);
  });

  it('si el envío falla, la fila se borra y NO cuenta para el límite por hora (§8.3)', async () => {
    mockTurnstile(true);
    const { res } = await pedirCodigo(VALIDO, { EMAIL: espia({ falla: true }) });
    expect(res.status).toBe(503);
    expect((await res.json()).message).toBe(FALLO);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM codigos').first()).n).toBe(0);

    // Y el votante no se queda encerrado una hora por una caída ajena.
    for (let i = 0; i < 3; i++) {
      mockTurnstile(true);
      const { res: r } = await pedirCodigo(VALIDO);
      expect(r.status).toBe(200);
    }
  });

  it('sin binding de correo responde el mensaje neutro, no un 500 con el motivo', async () => {
    mockTurnstile(true);
    const res = await handleCode(peticion(VALIDO), { ...env, ...VARS });
    expect(res.status).toBe(503);
    const cuerpo = await res.json();
    expect(cuerpo.message).toBe(FALLO);
    expect(cuerpo.message.toLowerCase()).not.toMatch(/binding|config|email service/);
  });

  it('rechaza fuera de la ventana de votación (403) sin gastar cuota', async () => {
    const ANTES = new Date('2026-10-01T12:00:00+02:00');
    const { res, EMAIL } = await pedirCodigo(VALIDO, { now: ANTES });
    expect(res.status).toBe(403);
    expect((await res.json()).message).toBe('La votación no está abierta.');
    expect(EMAIL.enviados).toHaveLength(0);
  });

  it('falla cerrado sin IP_SALT utilizable (500 neutro)', async () => {
    const res = await handleCode(peticion(VALIDO), { ...env, ...VARS, EMAIL: espia(), IP_SALT: undefined });
    expect(res.status).toBe(500);
    const cuerpo = await res.json();
    expect(cuerpo.message).toBe('No hemos podido registrar tu voto. Inténtalo de nuevo más tarde.');
    expect(cuerpo.message.toLowerCase()).not.toMatch(/sal|salt|config/);
  });

  it('la ruta existe y solo acepta POST', async () => {
    const get = await SELF.fetch('https://www.laorden.org/api/code');
    expect(get.status).toBe(404);
  });
});

describe('generarCodigo', () => {
  it('siempre son seis dígitos, ceros a la izquierda incluidos', () => {
    for (let i = 0; i < 500; i++) expect(generarCodigo()).toMatch(/^\d{6}$/);
  });

  it('no devuelve siempre el mismo', () => {
    const vistos = new Set();
    for (let i = 0; i < 50; i++) vistos.add(generarCodigo());
    expect(vistos.size).toBeGreaterThan(40);
  });
});

describe('hashCodigo', () => {
  it('separa dominios: el hash del código no coincide con el de la IP', async () => {
    const { hashIp } = await import('../src/lib/crypto.js');
    const h = await hashCodigo('sal', 'a@b.com', '123456');
    expect(h).not.toBe(await hashIp('a@b.com', 'sal'));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('depende del correo, del código y de la sal', async () => {
    const base = await hashCodigo('sal', 'a@b.com', '123456');
    expect(await hashCodigo('sal', 'otro@b.com', '123456')).not.toBe(base);
    expect(await hashCodigo('sal', 'a@b.com', '654321')).not.toBe(base);
    expect(await hashCodigo('otra-sal', 'a@b.com', '123456')).not.toBe(base);
    expect(await hashCodigo('sal', 'a@b.com', '123456')).toBe(base);
  });
});
