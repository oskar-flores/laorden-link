import { votingState } from '../lib/window.js';
import { readCookie, serialiseVoterCookie, VOTER_COOKIE } from '../lib/cookies.js';
import { hashIp, newVoterId } from '../lib/crypto.js';
import { verifyTurnstile } from '../lib/turnstile.js';

// Cortafuegos de abuso (§8). Deliberadamente alto: no debe saltar nunca
// para una familia ni para el wifi del local. NO es una regla de duplicados.
const ABUSE_IP_LIMIT = 20;

const MSG = {
  ok:        '¡Gracias! Tu voto se ha registrado.',
  duplicate: 'Ya se ha registrado un voto desde este dispositivo.',
  closed:    'La votación no está abierta.',
  turnstile: 'No hemos podido verificar que eres una persona.',
  badCode:   'Obra no válida.',
  abuse:     'Demasiados intentos. Inténtalo más tarde.'
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
  // 1. Ventana de votación, antes que nada.
  if (votingState(env, nowFrom(request, env)) !== 'open') {
    return json(403, false, MSG.closed);
  }

  // 2. Cuerpo y validación del código de obra.
  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, false, MSG.badCode);
  }
  if (typeof body !== 'object' || body === null) {
    return json(400, false, MSG.badCode);
  }
  if (!isValidMiniCode(body.mini_code, env.MINI_COUNT)) {
    return json(400, false, MSG.badCode);
  }
  const fingerprint = typeof body.fingerprint === 'string' ? body.fingerprint.slice(0, 128) : '';
  if (!fingerprint) return json(400, false, MSG.badCode);

  const ip = request.headers.get('CF-Connecting-IP') || '0.0.0.0';

  // 3. Turnstile antes que la deduplicación: frena lo único que escala de verdad.
  const human = await verifyTurnstile(body.turnstile_token, env.TURNSTILE_SECRET, ip);
  if (!human) return json(403, false, MSG.turnstile);

  // 4. Identidad del votante y hash de IP.
  const existingVoterId = readCookie(request, VOTER_COOKIE);
  const voterId = existingVoterId || newVoterId();
  const ipHash = await hashIp(ip, env.IP_SALT);
  const setCookie = { 'Set-Cookie': serialiseVoterCookie(voterId) };

  // 5. Cortafuegos de abuso por hash de IP (no es bloqueo por IP, §8).
  const abuse = await env.DB
    .prepare('SELECT COUNT(*) AS n FROM votes WHERE ip_hash = ?')
    .bind(ipHash).first();
  if (abuse && abuse.n >= ABUSE_IP_LIMIT) {
    return json(429, false, MSG.abuse, setCookie);
  }

  // 6. Duplicados: la cookie primero (señal barata, evita falsos positivos
  //    de huella en dispositivos idénticos, §8).
  const dupe = await env.DB
    .prepare(`SELECT 1 AS found FROM votes
              WHERE status = 'valid' AND (voter_id = ? OR fingerprint = ?) LIMIT 1`)
    .bind(voterId, fingerprint).first();
  if (dupe) return json(409, false, MSG.duplicate, setCookie);

  // 7. Inserción. Los índices únicos parciales son la garantía real frente
  //    a una carrera entre dos peticiones simultáneas.
  const cf = request.cf || {};
  try {
    await env.DB.prepare(
      `INSERT INTO votes
         (mini_code, voter_id, fingerprint, ip_hash, user_agent, country, asn, asn_name, created_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'valid')`
    ).bind(
      body.mini_code,
      voterId,
      fingerprint,
      ipHash,
      (request.headers.get('User-Agent') || '').slice(0, 512),
      cf.country || '',
      typeof cf.asn === 'number' ? cf.asn : null,
      cf.asOrganization || '',
      new Date().toISOString()
    ).run();
  } catch (err) {
    if (String(err).includes('UNIQUE')) return json(409, false, MSG.duplicate, setCookie);
    throw err;
  }

  return json(200, true, MSG.ok, setCookie);
}
