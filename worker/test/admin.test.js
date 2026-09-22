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
 *
 * Cada prueba que verifica un JWT real debe llamar a esto ella misma, al
 * principio: si solo se registrase en una prueba (p. ej. la del JWT válido),
 * ejecutar cualquier otra en solitario con `vitest -t` la dejaría sin mock,
 * `disableNetConnect()` bloquearía la petición, jwtVerify fallaría al
 * resolver la clave —no al comprobar audiencia/issuer/firma/caducidad— y el
 * 403 resultante no probaría nada (así se descubrió en el round 2/5).
 *
 * jose cachea el JWKS en memoria por proceso (jwksCache en access.js, ~10
 * min): dentro de una misma ejecución, solo la primera prueba que de verdad
 * necesita resolver una clave dispara la petición; las siguientes reutilizan
 * la caché en caliente y nunca llegan a esta función. El guardián `yaMockeado`
 * evita registrar un segundo interceptor persistido que nunca se consumiría
 * y quedaría pendiente para siempre; `.persist()` cubre el caso contrario
 * (una prueba sí necesita una segunda petición real).
 */
let yaMockeado = false;
function mockJwks() {
  if (yaMockeado) return;
  yaMockeado = true;
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

/**
 * Registra el manifiesto de obras.json que servirá `cargarObras` en
 * admin.js. No usa `.persist()`: cada prueba de la Tarea 3 hace como mucho
 * una petición de resultados, así que un interceptor de un solo uso basta y
 * `fetchMock.assertNoPendingInterceptors()` (si se usara) lo notaría si
 * sobrase alguno.
 */
function mockObras(lista) {
  fetchMock
    .get('https://www.laorden.org')
    .intercept({ path: '/concurso/obras.json', method: 'GET' })
    .reply(200, lista);
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
    mockJwks(); // autosuficiente: debe pasar también con `vitest -t`, en solitario
    const token = await firmar({ audience: 'otra-audiencia' });
    const res = await conToken(token);
    expect(res.status).toBe(403);
  });

  it('deniega un JWT con emisor incorrecto (403)', async () => {
    mockJwks();
    const token = await firmar({ issuer: 'https://otro-equipo.cloudflareaccess.com' });
    const res = await conToken(token);
    expect(res.status).toBe(403);
  });

  it('deniega un JWT con firma inválida aunque el kid sea el correcto (403)', async () => {
    mockJwks();
    // Mismo kid que la clave publicada, pero firmado con una clave distinta:
    // comprueba que se valida la firma criptográfica, no solo el kid.
    const token = await firmar({ clave: claveIntrusa.privateKey });
    const res = await conToken(token);
    expect(res.status).toBe(403);
  });

  it('deniega un JWT caducado (403)', async () => {
    mockJwks();
    const yaExpirado = Math.floor(Date.now() / 1000) - 3600;
    const token = await firmar({ exp: yaExpirado });
    const res = await conToken(token);
    expect(res.status).toBe(403);
  });

  it('marca f_volumen, f_datacenter y f_concentrado cuando los datos los disparan (G4)', async () => {
    await seed([
      // f_volumen: más de 5 votos desde el mismo hash de IP, a obras distintas
      // (para no disparar también f_concentrado).
      { mini_code: '01', voter_id: 'v-vol-1', fingerprint: 'f-vol-1', ip_hash: 'hash-volumen', asn_name: 'ISP Normal' },
      { mini_code: '02', voter_id: 'v-vol-2', fingerprint: 'f-vol-2', ip_hash: 'hash-volumen', asn_name: 'ISP Normal' },
      { mini_code: '03', voter_id: 'v-vol-3', fingerprint: 'f-vol-3', ip_hash: 'hash-volumen', asn_name: 'ISP Normal' },
      { mini_code: '04', voter_id: 'v-vol-4', fingerprint: 'f-vol-4', ip_hash: 'hash-volumen', asn_name: 'ISP Normal' },
      { mini_code: '05', voter_id: 'v-vol-5', fingerprint: 'f-vol-5', ip_hash: 'hash-volumen', asn_name: 'ISP Normal' },
      { mini_code: '06', voter_id: 'v-vol-6', fingerprint: 'f-vol-6', ip_hash: 'hash-volumen', asn_name: 'ISP Normal' },
      // f_datacenter: el nombre de la red delata un proveedor cloud/hosting/VPN;
      // solo 2 votos, para no disparar también f_volumen ni f_concentrado.
      { mini_code: '07', voter_id: 'v-dc-1', fingerprint: 'f-dc-1', ip_hash: 'hash-datacenter', asn_name: 'Acme Cloud Hosting' },
      { mini_code: '08', voter_id: 'v-dc-2', fingerprint: 'f-dc-2', ip_hash: 'hash-datacenter', asn_name: 'Acme Cloud Hosting' },
      // f_concentrado: más de 3 votos, todos a la misma obra.
      { mini_code: '09', voter_id: 'v-con-1', fingerprint: 'f-con-1', ip_hash: 'hash-concentrado', asn_name: 'ISP Normal' },
      { mini_code: '09', voter_id: 'v-con-2', fingerprint: 'f-con-2', ip_hash: 'hash-concentrado', asn_name: 'ISP Normal' },
      { mini_code: '09', voter_id: 'v-con-3', fingerprint: 'f-con-3', ip_hash: 'hash-concentrado', asn_name: 'ISP Normal' },
      { mini_code: '09', voter_id: 'v-con-4', fingerprint: 'f-con-4', ip_hash: 'hash-concentrado', asn_name: 'ISP Normal' }
    ]);

    mockJwks();
    const token = await firmar();
    const res = await conToken(token);
    expect(res.status).toBe(200);
    const body = await res.text();

    expect(body).not.toContain('Ningún origen marcado');
    expect(body).toContain('volumen');
    expect(body).toContain('datacenter');
    expect(body).toContain('concentrado');
  });

  it('lista los ids de cada origen marcado, que son los que pide el comando de anulación', async () => {
    // Sin esta columna la página dice "anula por id" y no enseña ni un id:
    // quien ve un origen sospechoso no tiene forma de llegar al comando.
    await seed([
      { mini_code: '09', voter_id: 'v-1', fingerprint: 'f-1', ip_hash: 'hash-ids', asn_name: 'ISP Normal' },
      { mini_code: '09', voter_id: 'v-2', fingerprint: 'f-2', ip_hash: 'hash-ids', asn_name: 'ISP Normal' },
      { mini_code: '09', voter_id: 'v-3', fingerprint: 'f-3', ip_hash: 'hash-ids', asn_name: 'ISP Normal' },
      { mini_code: '09', voter_id: 'v-4', fingerprint: 'f-4', ip_hash: 'hash-ids', asn_name: 'ISP Normal' }
    ]);

    mockJwks();
    const res = await conToken(await firmar());
    expect(res.status).toBe(200);
    const body = await res.text();

    // Los ids reales de las filas sembradas, tal y como los agrupa GROUP_CONCAT.
    const fila = await env.DB
      .prepare("SELECT GROUP_CONCAT(id) AS ids FROM votes WHERE ip_hash = 'hash-ids'")
      .first();
    expect(fila.ids).toMatch(/^\d+(,\d+)*$/);
    expect(body).toContain('<th>IDs</th>');
    expect(body).toContain(fila.ids);
  });

  it('una obra con img en obras.json sale con miniatura enlazada a la imagen grande (T3)', async () => {
    mockJwks();
    mockObras([{ code: '07', img: 'obras/07.webp', thumb: 'obras/07-thumb.webp' }]);
    await seed([{ mini_code: '07', voter_id: 'v1', fingerprint: 'f1', ip_hash: 'h1' }]);

    const res = await conToken(await firmar());
    expect(res.status).toBe(200);
    const body = await res.text();

    // El manifiesto trae rutas relativas a /concurso/; cargarObras debe
    // resolverlas contra ese prefijo, no dejarlas tal cual ni añadir /concurso/
    // dos veces.
    expect(body).toContain('<a href="/concurso/obras/07.webp">');
    expect(body).toContain(
      '<img class="miniatura" src="/concurso/obras/07-thumb.webp" alt="Obra 07" loading="lazy">'
    );
  });

  it('escapa el href y el alt de la miniatura con esc() (T3)', async () => {
    mockJwks();
    // Un código con comillas y `<script>` no debería nunca llegar así desde
    // la votación real, pero mini_code es un TEXT sin más restricción en la
    // base: si algo lo colase, la página no puede reproducirlo tal cual.
    const codigoRaro = '07"><script>x</script>';
    mockObras([{ code: codigoRaro, img: 'obras/raro.webp' }]);
    await seed([{ mini_code: codigoRaro, voter_id: 'v1', fingerprint: 'f1', ip_hash: 'h1' }]);

    const res = await conToken(await firmar());
    expect(res.status).toBe(200);
    const body = await res.text();

    expect(body).not.toContain('<script>x</script>');
    expect(body).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(body).toContain('&quot;');
  });

  it('una obra sin img en obras.json queda como texto plano, sin imagen rota (T3)', async () => {
    mockJwks();
    // 08 no tiene "img" en el manifiesto, como las 22 obras de hoy en
    // concurso/obras.json hasta que lleguen las fotos.
    mockObras([{ code: '08' }]);
    await seed([{ mini_code: '08', voter_id: 'v1', fingerprint: 'f1', ip_hash: 'h1' }]);

    const res = await conToken(await firmar());
    expect(res.status).toBe(200);
    const body = await res.text();

    expect(body).toContain('<td>#08</td>');
    expect(body).not.toContain('<img');
    expect(body).not.toContain('<a href');
  });

  it('si el fetch de obras.json falla, la tabla de recuento sigue apareciendo entera (T3)', async () => {
    mockJwks();
    // A propósito, NO se registra ningún interceptor para /concurso/obras.json:
    // con fetchMock.disableNetConnect() activo, ese fetch lanza, y cargarObras
    // debe atraparlo y devolver un índice vacío sin tumbar la página.
    await seed([
      { mini_code: '07', voter_id: 'v1', fingerprint: 'f1', ip_hash: 'h1' },
      { mini_code: '12', voter_id: 'v2', fingerprint: 'f2', ip_hash: 'h2' }
    ]);

    const res = await conToken(await firmar());
    expect(res.status).toBe(200);
    const body = await res.text();

    expect(body).toContain('Recuento');
    expect(body).toContain('<td>#07</td>');
    expect(body).toContain('<td>#12</td>');
    expect(body).not.toContain('<img');
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
