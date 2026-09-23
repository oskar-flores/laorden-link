import { votingState } from '../lib/window.js';
import { readCookie, serialiseVoterCookie, VOTER_COOKIE } from '../lib/cookies.js';
import { hashIp, newVoterId, saltIsUsable } from '../lib/crypto.js';
import { normalizarCorreo, correoValido } from '../lib/correo-norm.js';
import { hashCodigo } from '../lib/codigos.js';

// Cortafuegos de abuso (§8). Deliberadamente alto: la verificación por correo
// es ahora la defensa real, y anular fraude después es una decisión
// deliberada de la organización (bases §10), para la que existen las columnas
// asn/asn_name/country/ip_hash, los correos del panel y la consulta de
// orígenes de /admin/results. El único trabajo de este cortafuegos es frenar
// automatización desbocada — y no debe saltar nunca por una operadora móvil
// española detrás de un CGNAT compartido por cientos de personas.
const ABUSE_IP_LIMIT = 200;

const MSG = {
  ok:            '¡Gracias! Tu voto se ha registrado.',
  duplicadoCorreo: 'Ya has votado con esta dirección de correo.',
  duplicadoNavegador: 'Ya se ha registrado un voto desde este navegador.',
  closed:        'La votación no está abierta.',
  badCode:       'Obra no válida.',
  correoMal:     'Escribe una dirección de correo válida.',
  // Código incorrecto, caducado, muerto por intentos, ya usado o de forma
  // imposible: todos el MISMO texto. Distinguirlos le diría a quien sondea si
  // hay un código vivo para esa dirección (§8.2).
  codigoMal:     'El código no es correcto o ha caducado. Pide uno nuevo.',
  abuse:         'Demasiados intentos. Inténtalo más tarde.',
  serverError:   'No hemos podido registrar tu voto. Inténtalo de nuevo más tarde.'
};

function json(status, ok, message, extraHeaders = {}) {
  return Response.json({ ok, message }, {
    status,
    headers: { 'Cache-Control': 'no-store', ...extraHeaders }
  });
}

function isValidMiniCode(code, miniCount) {
  if (typeof code !== 'string' || !/^\d{2}$/.test(code)) return false;
  const n = Number(code);
  return n >= 1 && n <= Number(miniCount);
}

/** Reloj controlable solo en pruebas; producción nunca define ALLOW_TEST_CLOCK. */
function nowFrom(request, env) {
  if (env.ALLOW_TEST_CLOCK) {
    const header = request.headers.get('X-Test-Now');
    if (header) {
      const t = new Date(header).getTime();
      if (!Number.isNaN(t)) return t;
    }
  }
  return Date.now();
}

export async function handleVote(request, env) {
  // 1. Salvaguarda de privacidad (G1): sin IP_SALT utilizable no se puede ni
  //    cumplir la promesa de "hash irreversible" de privacidad.html ni
  //    verificar el código. Fallar cerrado, con un mensaje neutro.
  if (!saltIsUsable(env.IP_SALT)) return json(500, false, MSG.serverError);

  // 2. Ventana de votación.
  if (votingState(env, nowFrom(request, env)) !== 'open') {
    return json(403, false, MSG.closed);
  }

  // 3. Cuerpo.
  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, false, MSG.badCode);
  }
  if (typeof body !== 'object' || body === null) return json(400, false, MSG.badCode);
  if (!isValidMiniCode(body.mini_code, env.MINI_COUNT)) return json(400, false, MSG.badCode);
  if (!correoValido(body.correo)) return json(400, false, MSG.correoMal);

  const correo = String(body.correo).trim();
  const emailNorm = normalizarCorreo(correo);

  // Una forma imposible se responde igual que un código malo: no hay oráculo
  // que distinga "no existe" de "no es el tuyo".
  const codigo = typeof body.codigo === 'string' ? body.codigo.trim() : '';
  if (!/^\d{6}$/.test(codigo)) return json(400, false, MSG.codigoMal);

  // 4. El código vivo más reciente de esa dirección.
  const fila = await env.DB.prepare(
    `SELECT id, codigo_hash, expira_en FROM codigos
     WHERE email_norm = ? AND usado_en IS NULL
     ORDER BY id DESC LIMIT 1`
  ).bind(emailNorm).first();
  if (!fila) return json(400, false, MSG.codigoMal);

  const ahora = new Date();
  if (new Date(fila.expira_en).getTime() <= ahora.getTime()) {
    return json(400, false, MSG.codigoMal);
  }

  const maxIntentos = Number(env.CODIGO_INTENTOS);
  // Reserva el intento ANTES de comparar el hash: así el límite lo impone la
  // base bajo concurrencia, no una lectura en memoria que dos peticiones
  // pueden compartir. Una petición que no consigue plaza (código ya cerrado,
  // o ya al tope) nunca llega a comparar el hash -- y por tanto nunca puede
  // acertar, por muchas peticiones simultáneas que se lancen.
  const turno = await env.DB.prepare(
    `UPDATE codigos SET intentos = intentos + 1
     WHERE id = ? AND usado_en IS NULL AND intentos < ?
     RETURNING intentos`
  ).bind(fila.id, maxIntentos).first();
  if (!turno) return json(400, false, MSG.codigoMal);

  const esperado = await hashCodigo(env.IP_SALT, emailNorm, codigo);
  if (esperado !== fila.codigo_hash) {
    if (turno.intentos >= maxIntentos) {
      await env.DB.prepare(
        'UPDATE codigos SET usado_en = ? WHERE id = ? AND usado_en IS NULL'
      ).bind(ahora.toISOString(), fila.id).run();
    }
    return json(400, false, MSG.codigoMal);
  }

  // A partir de aquí el control del buzón está demostrado.
  const ip = request.headers.get('CF-Connecting-IP') || '0.0.0.0';
  const existingVoterId = readCookie(request, VOTER_COOKIE);
  const voterId = existingVoterId || newVoterId();
  const ipHash = await hashIp(ip, env.IP_SALT);
  const setCookie = { 'Set-Cookie': serialiseVoterCookie(voterId) };

  /** El código está gastado desde el momento en que se acierta, salga lo que salga después. */
  const gastarCodigo = () => env.DB
    .prepare('UPDATE codigos SET usado_en = ? WHERE id = ?')
    .bind(ahora.toISOString(), fila.id).run();

  // 5. Duplicado por dirección. Solo AQUÍ se puede decir "ya has votado" sin
  //    revelar nada de un tercero.
  const yaVoto = await env.DB
    .prepare("SELECT 1 AS found FROM votes WHERE status = 'valid' AND email_norm = ? LIMIT 1")
    .bind(emailNorm).first();
  if (yaVoto) {
    await gastarCodigo();
    return json(409, false, MSG.duplicadoCorreo, setCookie);
  }

  // 6. Duplicado por navegador. La huella se fue (§3.3); la cookie se queda.
  const yaNavegador = await env.DB
    .prepare("SELECT 1 AS found FROM votes WHERE status = 'valid' AND voter_id = ? LIMIT 1")
    .bind(voterId).first();
  if (yaNavegador) {
    await gastarCodigo();
    return json(409, false, MSG.duplicadoNavegador, setCookie);
  }

  // 7. Cortafuegos de abuso por hash de IP (no es bloqueo por IP, §8). Solo
  //    cuentan los votos válidos: uno anulado devuelve su cupo a esa IP.
  const abuse = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM votes WHERE ip_hash = ? AND status = 'valid'")
    .bind(ipHash).first();
  if (abuse && abuse.n >= ABUSE_IP_LIMIT) {
    return json(429, false, MSG.abuse, setCookie);
  }

  // 8. Inserción. Los índices únicos parciales son la garantía real frente a
  //    una carrera entre dos peticiones simultáneas.
  const cf = request.cf || {};
  try {
    await env.DB.prepare(
      `INSERT INTO votes
         (mini_code, voter_id, ip_hash, user_agent, country, asn, asn_name,
          created_at, status, email, email_norm, origen, nota)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'valid', ?, ?, 'web', '')`
    ).bind(
      body.mini_code,
      voterId,
      ipHash,
      (request.headers.get('User-Agent') || '').slice(0, 512),
      cf.country || '',
      typeof cf.asn === 'number' ? cf.asn : null,
      cf.asOrganization || '',
      ahora.toISOString(),
      correo,
      emailNorm
    ).run();
  } catch (err) {
    if (String(err).includes('UNIQUE')) {
      await gastarCodigo();
      return json(409, false, MSG.duplicadoCorreo, setCookie);
    }
    throw err;
  }

  await gastarCodigo();
  return json(200, true, MSG.ok, setCookie);
}
