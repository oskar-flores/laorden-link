import { votingState } from '../lib/window.js';
import { hashIp, saltIsUsable } from '../lib/crypto.js';
import { verifyTurnstile } from '../lib/turnstile.js';
import { normalizarCorreo, correoValido } from '../lib/correo-norm.js';
import { generarCodigo, hashCodigo } from '../lib/codigos.js';
import { enviarCodigo } from '../lib/correo.js';

// Por ip_hash y por hora. La misma tensión ya documentada para ABUSE_IP_LIMIT:
// cientos de personas comparten una IP de CGNAT. 20 es deliberadamente laxo —
// pedir un código es un acto raro, a diferencia de votar.
// No es una var: no hay ningún escenario en el que se quiera tocar sin
// desplegar, y una var más es una var más que repetir en cada entorno.
const CODIGOS_POR_IP_HORA = 20;
const VENTANA_MINUTOS = 60;

const MSG = {
  enviado:     'Si la dirección es correcta, te hemos enviado un código.',
  correoMal:   'Escribe una dirección de correo válida.',
  demasiados:  'Has pedido demasiados códigos. Espera una hora e inténtalo de nuevo.',
  demasiadosIp: 'Hay mucho tráfico desde tu red ahora mismo. Prueba de nuevo en un rato, o escribe a laordenaslu@gmail.com si el problema persiste.',
  turnstile:   'No hemos podido verificar que eres una persona.',
  cerrada:     'La votación no está abierta.',
  falloEnvio:  'No hemos podido enviarte el código. Escribe a laordenaslu@gmail.com y te ayudamos a votar.',
  serverError: 'No hemos podido registrar tu voto. Inténtalo de nuevo más tarde.'
};

function json(status, ok, message) {
  return Response.json({ ok, message }, {
    status, headers: { 'Cache-Control': 'no-store' }
  });
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

export async function handleCode(request, env) {
  // 0. Sin IP_SALT utilizable no se puede ni hashear la IP ni firmar el
  //    código: fallar cerrado con un mensaje neutro, igual que /api/vote.
  if (!saltIsUsable(env.IP_SALT)) return json(500, false, MSG.serverError);

  // 0b. Fuera de la ventana el código no serviría para nada y el envío sería
  //     cuota quemada. No está en el spec; es la lectura evidente del §5.
  if (votingState(env, nowFrom(request, env)) !== 'open') {
    return json(403, false, MSG.cerrada);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  if (typeof body !== 'object' || body === null) body = {};

  const ip = request.headers.get('CF-Connecting-IP') || '0.0.0.0';

  // 1. Turnstile PRIMERO, aunque cueste un fetch: es la única capa que
  //    distingue a una persona de un script, y las demás son lecturas de base
  //    que no hay que servirle a un bot.
  const human = await verifyTurnstile(body.turnstile_token, env.TURNSTILE_SECRET, ip);
  if (!human) return json(403, false, MSG.turnstile);

  // 2. Forma de la dirección y longitud máxima (254, RFC 5321).
  if (!correoValido(body.correo)) return json(400, false, MSG.correoMal);
  const correo = String(body.correo).trim();
  const emailNorm = normalizarCorreo(correo);

  const ipHash = await hashIp(ip, env.IP_SALT);
  const desde = new Date(Date.now() - VENTANA_MINUTOS * 60_000).toISOString();

  // 3. Límite por dirección: el freno antimailbomb. Nadie usa la dirección de
  //    otro para llenarle el buzón.
  const porCorreo = await env.DB
    .prepare('SELECT COUNT(*) AS n FROM codigos WHERE email_norm = ? AND created_at > ?')
    .bind(emailNorm, desde).first();
  if (porCorreo && porCorreo.n >= Number(env.CODIGOS_POR_HORA)) {
    return json(429, false, MSG.demasiados);
  }

  // 4. Límite por origen.
  const porIp = await env.DB
    .prepare('SELECT COUNT(*) AS n FROM codigos WHERE ip_hash = ? AND created_at > ?')
    .bind(ipHash, desde).first();
  if (porIp && porIp.n >= CODIGOS_POR_IP_HORA) {
    return json(429, false, MSG.demasiadosIp);
  }

  // 5. Techo global del día. Es el más importante de los cinco mandos: lo que
  //    impide que un fallo queme la cuota del mes y la reputación del dominio
  //    días antes de que abra la votación.
  const hoy = new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';
  const delDia = await env.DB
    .prepare('SELECT COUNT(*) AS n FROM codigos WHERE created_at >= ?')
    .bind(hoy).first();
  if (delDia && delDia.n >= Number(env.MAX_CORREOS_DIA)) {
    // Nunca "cuota agotada": ni es problema del votante, ni se le dice a un
    // atacante que se ha llegado al techo. El mensaje apunta al voto asistido.
    return json(503, false, MSG.falloEnvio);
  }

  // 6. Si esa dirección ya votó, la respuesta es EXACTAMENTE la misma que si
  //    no — pero no se manda nada ni se gasta cuota. Decir aquí "ya has
  //    votado" dejaría sondear direcciones ajenas para saber quién ha votado.
  const yaVoto = await env.DB
    .prepare("SELECT 1 AS found FROM votes WHERE status = 'valid' AND email_norm = ? LIMIT 1")
    .bind(emailNorm).first();
  if (yaVoto) return json(200, true, MSG.enviado);

  const codigo = generarCodigo();
  const ahora = new Date();
  const expira = new Date(ahora.getTime() + Number(env.CODIGO_MINUTOS) * 60_000);

  const insertado = await env.DB.prepare(
    `INSERT INTO codigos (email_norm, codigo_hash, expira_en, intentos, ip_hash, created_at)
     VALUES (?, ?, ?, 0, ?, ?) RETURNING id`
  ).bind(
    emailNorm,
    await hashCodigo(env.IP_SALT, emailNorm, codigo),
    expira.toISOString(),
    ipHash,
    ahora.toISOString()
  ).first();

  // El código se manda a la dirección TAL CUAL la escribió la persona (§6.3).
  const enviado = await enviarCodigo(env, correo, codigo);
  if (!enviado) {
    // Se borra la fila y el intento NO cuenta para el límite por hora: si no,
    // una caída ajena dejaría al votante encerrado sesenta minutos (§8.3).
    await env.DB.prepare('DELETE FROM codigos WHERE id = ?').bind(insertado.id).run();
    return json(503, false, MSG.falloEnvio);
  }

  return json(200, true, MSG.enviado);
}
