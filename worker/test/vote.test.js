import { env, applyD1Migrations, SELF, fetchMock } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { handleVote } from '../src/routes/vote.js';
import { hashIp } from '../src/lib/crypto.js';
import { hashCodigo } from '../src/lib/codigos.js';

const IP_SALT_DE_PRUEBAS = 'sal-de-pruebas';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

beforeEach(async () => {
  await env.DB.exec('DELETE FROM votes');
  await env.DB.exec('DELETE FROM codigos');
});

const DURANTE = new Date('2026-10-14T12:00:00+02:00');
const ANTES   = new Date('2026-10-01T12:00:00+02:00');
const DESPUES = new Date('2026-10-18T12:00:00+02:00');

const CORREO = 'Fulano.Perez@Gmail.com';
const NORM = 'fulanoperez@gmail.com';
const CODIGO = '123456';

/**
 * Siembra un código vivo para `norm` y devuelve su id.
 * Los seis dígitos nunca se guardan: solo su HMAC.
 */
async function sembrarCodigo({ norm = NORM, codigo = CODIGO, minutos = 10, intentos = 0, usado = null } = {}) {
  const ahora = new Date();
  const fila = await env.DB.prepare(
    `INSERT INTO codigos (email_norm, codigo_hash, expira_en, intentos, ip_hash, created_at, usado_en)
     VALUES (?, ?, ?, ?, 'hash-ip', ?, ?) RETURNING id`
  ).bind(
    norm,
    await hashCodigo(IP_SALT_DE_PRUEBAS, norm, codigo),
    new Date(ahora.getTime() + minutos * 60_000).toISOString(),
    intentos,
    ahora.toISOString(),
    usado
  ).first();
  return fila.id;
}

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

/** Petición cruda, para llamar a handleVote con un env alterado. */
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

async function seedVotes(rows) {
  const stmt = env.DB.prepare(
    `INSERT INTO votes (mini_code, voter_id, ip_hash, created_at, status, email, email_norm)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  await env.DB.batch(rows.map((r) => stmt.bind(
    r.mini_code || '07', r.voter_id, r.ip_hash,
    r.created_at || new Date().toISOString(), r.status || 'valid',
    r.email || '', r.email_norm || ''
  )));
}

const VALIDO = { mini_code: '07', correo: CORREO, codigo: CODIGO };
const MAL_O_CADUCADO = 'El código no es correcto o ha caducado. Pide uno nuevo.';

describe('POST /api/vote', () => {
  it('registra el voto al canjear un código bueno', async () => {
    await sembrarCodigo();
    const res = await vote(VALIDO);
    expect(res.status).toBe(200);
    expect((await res.json()).message).toBe('¡Gracias! Tu voto se ha registrado.');

    const fila = await env.DB.prepare('SELECT * FROM votes').first();
    expect(fila.mini_code).toBe('07');
    expect(fila.status).toBe('valid');
    // El panel enseña lo que escribió la persona; el índice único usa la forma canónica.
    expect(fila.email).toBe(CORREO);
    expect(fila.email_norm).toBe(NORM);
    expect(fila.origen).toBe('web');
    expect(fila.nota).toBe('');
  });

  it('marca el código como usado y no deja canjearlo dos veces', async () => {
    await sembrarCodigo();
    expect((await vote(VALIDO)).status).toBe(200);

    const fila = await env.DB.prepare('SELECT usado_en FROM codigos').first();
    expect(fila.usado_en).not.toBe(null);

    // Aunque se anule el voto para liberar la dirección, el código está gastado.
    await env.DB.exec("UPDATE votes SET status = 'annulled'");
    const res = await vote(VALIDO);
    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe(MAL_O_CADUCADO);
  });

  it('emite la cookie con las banderas correctas', async () => {
    await sembrarCodigo();
    const cookie = (await vote(VALIDO)).headers.get('Set-Cookie');
    expect(cookie).toContain('voter_id=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=2592000');
  });

  it('ya no llama a Turnstile: el voto no lo lleva (§5)', async () => {
    // fetchMock está con disableNetConnect(): si vote.js llamase a
    // siteverify, la petición reventaría y esto sería un 403.
    await sembrarCodigo();
    expect((await vote(VALIDO)).status).toBe(200);
  });

  // El §8.2 es explícito: distinguirlos le diría a quien sondea si existe un
  // código vivo para esa dirección.
  it('el código incorrecto y el caducado dan EXACTAMENTE el mismo mensaje', async () => {
    await sembrarCodigo({ codigo: '111111' });
    const malo = await vote({ ...VALIDO, codigo: '999999' });
    expect(malo.status).toBe(400);
    const m1 = (await malo.json()).message;

    await env.DB.exec('DELETE FROM codigos');
    await sembrarCodigo({ minutos: -1 });          // ya caducado
    const viejo = await vote(VALIDO);
    expect(viejo.status).toBe(400);
    const m2 = (await viejo.json()).message;

    expect(m1).toBe(MAL_O_CADUCADO);
    expect(m2).toBe(MAL_O_CADUCADO);
  });

  it('sin ningún código pedido, el mismo mensaje otra vez', async () => {
    const res = await vote(VALIDO);
    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe(MAL_O_CADUCADO);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM votes').first()).n).toBe(0);
  });

  it('cada fallo suma un intento', async () => {
    const id = await sembrarCodigo();
    await vote({ ...VALIDO, codigo: '000000' });
    await vote({ ...VALIDO, codigo: '000001' });
    const fila = await env.DB.prepare('SELECT intentos, usado_en FROM codigos WHERE id = ?').bind(id).first();
    expect(fila.intentos).toBe(2);
    expect(fila.usado_en).toBe(null);
  });

  it('a los 5 fallos el código muere y ni siquiera el bueno lo revive', async () => {
    const id = await sembrarCodigo();
    for (let i = 0; i < 5; i++) {
      const res = await vote({ ...VALIDO, codigo: '00000' + i });
      expect(res.status).toBe(400);
    }
    const fila = await env.DB.prepare('SELECT intentos, usado_en FROM codigos WHERE id = ?').bind(id).first();
    expect(fila.intentos).toBe(5);
    expect(fila.usado_en).not.toBe(null);

    const res = await vote(VALIDO);
    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe(MAL_O_CADUCADO);
  });

  it('el código de Fulano no sirve para votar con la dirección de otro', async () => {
    await sembrarCodigo();
    const res = await vote({ ...VALIDO, correo: 'mengano@ejemplo.com' });
    expect(res.status).toBe(400);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM votes').first()).n).toBe(0);
  });

  it('acepta cualquier forma de la misma dirección de Gmail', async () => {
    await sembrarCodigo();                                   // sembrado sobre NORM
    const res = await vote({ ...VALIDO, correo: 'fulanoperez+concurso@gmail.com' });
    expect(res.status).toBe(200);
  });

  // Solo AQUÍ es seguro decirlo: el control del buzón está demostrado, así que
  // no se revela nada de un tercero.
  it('rechaza el segundo voto de la misma dirección (409) y lo dice claro', async () => {
    await sembrarCodigo();
    expect((await vote(VALIDO)).status).toBe(200);

    await env.DB.exec('DELETE FROM codigos');
    await sembrarCodigo({ codigo: '654321' });
    const res = await vote({ ...VALIDO, codigo: '654321' });
    expect(res.status).toBe(409);
    expect((await res.json()).message).toBe('Ya has votado con esta dirección de correo.');
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM votes').first()).n).toBe(1);
  });

  it('dos formas distintas de la misma dirección de Gmail son un solo voto', async () => {
    await sembrarCodigo();
    expect((await vote(VALIDO)).status).toBe(200);

    await env.DB.exec('DELETE FROM codigos');
    await sembrarCodigo({ codigo: '654321' });
    const res = await vote({ mini_code: '03', correo: 'FULANO.PEREZ@googlemail.com'.replace('googlemail', 'gmail'), codigo: '654321' });
    expect(res.status).toBe(409);
  });

  it('anular un voto libera la dirección (índice único parcial)', async () => {
    await sembrarCodigo();
    expect((await vote(VALIDO)).status).toBe(200);
    await env.DB.exec("UPDATE votes SET status = 'annulled'");

    await env.DB.exec('DELETE FROM codigos');
    await sembrarCodigo({ codigo: '654321' });
    const res = await vote({ ...VALIDO, codigo: '654321' });
    expect(res.status).toBe(200);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM votes WHERE status='valid'").first()).n).toBe(1);
  });

  it('rechaza un segundo voto con la misma cookie (409)', async () => {
    await sembrarCodigo();
    const primero = await vote(VALIDO);
    const voterId = primero.headers.get('Set-Cookie').match(/voter_id=([^;]+)/)[1];

    await env.DB.exec('DELETE FROM codigos');
    await sembrarCodigo({ norm: 'otra@ejemplo.com', codigo: '654321' });
    const res = await vote({ mini_code: '03', correo: 'otra@ejemplo.com', codigo: '654321' },
                           { cookie: `voter_id=${voterId}` });
    expect(res.status).toBe(409);
    expect((await res.json()).message).toBe('Ya se ha registrado un voto desde este navegador.');
  });

  it('rechaza antes de la apertura (403)', async () => {
    await sembrarCodigo();
    const res = await vote(VALIDO, { now: ANTES });
    expect(res.status).toBe(403);
    expect((await res.json()).message).toBe('La votación no está abierta.');
  });

  it('rechaza después del cierre (403)', async () => {
    await sembrarCodigo();
    expect((await vote(VALIDO, { now: DESPUES })).status).toBe(403);
  });

  it.each(['00', '11', '23', 'abc', '1', '007', '', null])(
    'rechaza el código de obra %p (400)', async (codigo) => {
      await sembrarCodigo();
      const res = await vote({ ...VALIDO, mini_code: codigo });
      expect(res.status).toBe(400);
      expect((await res.json()).message).toBe('Obra no válida.');
    }
  );

  it.each(['', 'sin-arroba', null, 1234])('rechaza la dirección %p (400)', async (correo) => {
    await sembrarCodigo();
    const res = await vote({ ...VALIDO, correo });
    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe('Escribe una dirección de correo válida.');
  });

  it.each(['12345', '1234567', 'abcdef', '', null])(
    'un código de forma imposible da el mismo mensaje que uno malo (%p)', async (codigo) => {
      await sembrarCodigo();
      const res = await vote({ ...VALIDO, codigo });
      expect(res.status).toBe(400);
      expect((await res.json()).message).toBe(MAL_O_CADUCADO);
    }
  );

  it('rechaza un cuerpo JSON `null` (400)', async () => {
    const res = await vote(null);
    expect(res.status).toBe(400);
  });

  it('no guarda nunca la IP en claro (§12)', async () => {
    await sembrarCodigo();
    await vote(VALIDO, { ip: '81.44.123.45' });
    const { results } = await env.DB.prepare('SELECT * FROM votes').all();
    expect(JSON.stringify(results)).not.toContain('81.44.123.45');
    expect(results[0].ip_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ya no corta a un votante 21 de la misma IP — el CGNAT de una operadora no debe bloquear', async () => {
    const ip = '81.0.0.9';
    const ipHash = await hashIp(ip, IP_SALT_DE_PRUEBAS);
    const filas = [];
    for (let i = 0; i < 50; i++) {
      filas.push({ voter_id: `votante-cgnat-${i}`, ip_hash: ipHash, email_norm: `c${i}@ejemplo.com` });
    }
    await seedVotes(filas);

    await sembrarCodigo();
    const res = await vote(VALIDO, { ip });
    expect(res.status).toBe(200);
  });

  it('el cortafuegos de abuso sigue saltando a los 200 votos del mismo origen (429)', async () => {
    const ip = '81.0.0.8';
    const ipHash = await hashIp(ip, IP_SALT_DE_PRUEBAS);
    const filas = [];
    for (let i = 0; i < 200; i++) {
      filas.push({ voter_id: `votante-abuso-${i}`, ip_hash: ipHash, email_norm: `a${i}@ejemplo.com` });
    }
    await seedVotes(filas);

    await sembrarCodigo();
    const res = await vote(VALIDO, { ip });
    expect(res.status).toBe(429);
    expect((await res.json()).message).toBe('Demasiados intentos. Inténtalo más tarde.');
  });

  it('guarda asn, asn_name y country sin romperse si falta el objeto cf', async () => {
    await sembrarCodigo();
    expect((await vote(VALIDO)).status).toBe(200);
    const fila = await env.DB.prepare('SELECT asn, asn_name, country FROM votes').first();
    expect(fila.asn_name).toBe('');
    expect(fila.country).toBe('');
  });

  it('dos peticiones simultáneas con el mismo correo dejan una sola fila', async () => {
    // La afirmación central del §6: el índice único parcial resuelve la
    // carrera, no el código de la aplicación. El perdedor puede morir en el
    // índice único (409, ya votado) o -- si el ganador completa su UPDATE de
    // codigos antes de que el perdedor lea la fila -- al encontrar el código
    // ya usado (400). Las dos son aceptables: lo que importa es que quede
    // exactamente una fila válida.
    await sembrarCodigo();
    const [a, b] = await Promise.all([vote(VALIDO), vote(VALIDO)]);
    const estados = [a.status, b.status].sort((x, y) => x - y);
    expect(estados[0]).toBe(200);
    expect([400, 409]).toContain(estados[1]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM votes WHERE status='valid'").first()).n).toBe(1);
  });

  it('rechaza GET en la ruta de voto', async () => {
    expect((await SELF.fetch('https://www.laorden.org/api/vote')).status).toBe(404);
  });
});

describe('IP_SALT — falla cerrado si no es utilizable (G1)', () => {
  it('rechaza el voto si IP_SALT no está definido (500, mensaje neutro)', async () => {
    await sembrarCodigo();
    const res = await handleVote(peticionVoto(VALIDO), { ...env, IP_SALT: undefined });
    expect(res.status).toBe(500);
    const cuerpo = await res.json();
    expect(cuerpo.ok).toBe(false);
    expect(cuerpo.message).toBe('No hemos podido registrar tu voto. Inténtalo de nuevo más tarde.');
    expect(cuerpo.message.toLowerCase()).not.toMatch(/sal|salt|config/);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM votes').first()).n).toBe(0);
  });

  it('rechaza el voto si IP_SALT es la cadena vacía (500)', async () => {
    await sembrarCodigo();
    const res = await handleVote(peticionVoto(VALIDO), { ...env, IP_SALT: '' });
    expect(res.status).toBe(500);
  });
});
