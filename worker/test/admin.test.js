import { env, applyD1Migrations, SELF, fetchMock } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { verifyAccessJwt } from '../src/lib/access.js';

// Deben coincidir con ACCESS_TEAM_DOMAIN / ACCESS_AUD en vitest.config.js.
const TEAM_DOMAIN = 'equipo-de-pruebas.cloudflareaccess.com';
const AUD = 'aud-de-pruebas';
const ISSUER = `https://${TEAM_DOMAIN}`;
const KID = 'clave-de-pruebas-1';

let claveBuena; // par de claves cuya pública se publica en el JWKS de pruebas
let claveIntrusa; // par ajeno, no publicado — para el JWT con firma inválida
let jwks;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  fetchMock.activate();
  fetchMock.disableNetConnect();

  claveBuena = await generateKeyPair('RS256', { extractable: true });
  claveIntrusa = await generateKeyPair('RS256', { extractable: true });

  const jwk = await exportJWK(claveBuena.publicKey);
  jwk.kid = KID;
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  jwks = { keys: [jwk] };
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

/**
 * Publica el JWKS de pruebas en el endpoint que consulta lib/access.js.
 * jose cachea el resultado en memoria (jwksCache en access.js, ~10 min), así
 * que solo la primera verificación de un JWT bien formado de esta suite
 * dispara la petición real; las siguientes reutilizan la caché en caliente.
 * Se usa .persist() para no depender de ese supuesto: si alguna otra prueba
 * disparase una segunda petición, también se serviría en vez de fallar por
 * "no matching interceptor".
 */
function mockJwks() {
  fetchMock
    .get(`https://${TEAM_DOMAIN}`)
    .intercept({ path: '/cdn-cgi/access/certs', method: 'GET' })
    .reply(200, jwks)
    .persist();
}

function firmar({
  issuer = ISSUER,
  audience = AUD,
  kid = KID,
  clave = claveBuena.privateKey,
  exp,
  email = 'jueza@laorden.org'
} = {}) {
  const token = new SignJWT({ email })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuedAt()
    .setIssuer(issuer)
    .setAudience(audience)
    .setExpirationTime(exp === undefined ? '10m' : exp);
  return token.sign(clave);
}

function conToken(token) {
  return SELF.fetch('https://www.laorden.org/admin/results', {
    headers: { 'Cf-Access-Jwt-Assertion': token }
  });
}

describe('GET /admin/results', () => {
  it('deniega el acceso sin cabecera de Access', async () => {
    const res = await SELF.fetch('https://www.laorden.org/admin/results');
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).not.toContain('Recuento');
  });

  it('deniega el acceso con un JWT malformado', async () => {
    // Con ACCESS_TEAM_DOMAIN/ACCESS_AUD ya configurados en vitest.config.js,
    // esta petición ya no corta en la guarda de "no configurado": llega de
    // verdad a jwtVerify, que falla al decodificar la cabecera, y cae en el
    // catch. Es el caso que el round anterior dejaba sin ejercer.
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
    // No basta con que el Content-Type no sea JSON: un 404 del catch-all de
    // /api también lo cumpliría. Hay que comprobar la denegación real.
    const res = await SELF.fetch('https://www.laorden.org/admin/results');
    expect(res.status).toBe(403);
    expect(res.headers.get('Content-Type') || '').toContain('text/plain');
    expect(await res.text()).toBe('Acceso denegado.');
  });

  it('una subruta desconocida de /admin devuelve 404, no el recuento', async () => {
    const res = await SELF.fetch('https://www.laorden.org/admin/otra-cosa');
    expect(res.status).toBe(404);
  });

  it('acepta un JWT válido: 200 y el recuento sellado aparece en la página', async () => {
    mockJwks();
    await seed([{ mini_code: '07', voter_id: 'v1', fingerprint: 'f1', ip_hash: 'h1' }]);
    const token = await firmar();

    const res = await conToken(token);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Recuento');
    expect(body).toContain('#07');
    expect(body).toContain('jueza@laorden.org');

    // Confirma que el JWKS mockeado se consumió (no queda pendiente/sin usar).
    fetchMock.assertNoPendingInterceptors();
  });

  it('deniega un JWT con audiencia incorrecta (403) — el aud sí se comprueba', async () => {
    const token = await firmar({ audience: 'otra-audiencia' });
    const res = await conToken(token);
    expect(res.status).toBe(403);
  });

  it('deniega un JWT con emisor incorrecto (403)', async () => {
    const token = await firmar({ issuer: 'https://otro-equipo.cloudflareaccess.com' });
    const res = await conToken(token);
    expect(res.status).toBe(403);
  });

  it('deniega un JWT con firma inválida aunque el kid sea el correcto (403)', async () => {
    // Mismo kid que la clave publicada, pero firmado con una clave distinta:
    // comprueba que se valida la firma criptográfica, no solo el kid.
    const token = await firmar({ clave: claveIntrusa.privateKey });
    const res = await conToken(token);
    expect(res.status).toBe(403);
  });

  it('deniega un JWT caducado (403)', async () => {
    const yaExpirado = Math.floor(Date.now() / 1000) - 3600;
    const token = await firmar({ exp: yaExpirado });
    const res = await conToken(token);
    expect(res.status).toBe(403);
  });

  it('deniega incluso un JWT válido si ACCESS_TEAM_DOMAIN/ACCESS_AUD aún no están configurados', async () => {
    // Cubre el estado real de wrangler.toml hoy (cadenas vacías, se rellenan
    // en la Tarea 6): la guarda de verifyAccessJwt debe cortar en seco antes
    // de intentar verificar nada, incluso con un JWT por lo demás válido.
    // Se llama a verifyAccessJwt directamente porque los bindings globales de
    // vitest.config.js ya no están vacíos para el resto de esta suite.
    const token = await firmar();
    const req = new Request('https://www.laorden.org/admin/results', {
      headers: { 'Cf-Access-Jwt-Assertion': token }
    });
    const resultado = await verifyAccessJwt(req, { ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '' });
    expect(resultado.ok).toBe(false);
  });
});
