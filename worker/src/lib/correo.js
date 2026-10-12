/**
 * Envío del código de verificación (spec 2026-09-22 §7).
 *
 * El ÚNICO sitio del Worker que sabe quién manda el correo. Es toda la razón
 * de que se eligiera Cloudflare Email Service y no un proveedor externo: si
 * la prueba de entregabilidad del §14 sale mal, cambiar a Resend, Brevo o
 * Mailgun es este fichero, no un rediseño.
 *
 * FALLA CERRADO: si el binding falta o está mal configurado, devuelve false y
 * quien llama contesta con el mensaje neutro del §8.3. Nunca lanza, nunca
 * devuelve un 500 con el motivo, y nunca se registra un código que no se pudo
 * entregar. Es el mismo trato que recibe hoy IP_SALT.
 */

const ASUNTO = 'Tu código para votar en el concurso de La Orden';

function texto(codigo, minutos) {
  return `Tu código para votar es:

  ${codigo}

Caduca en ${minutos} minutos y solo se puede usar una vez. Escríbelo en la
página de la votación para confirmar tu voto.

Si no has pedido este código, no hagas nada: sin él, nadie puede votar con
tu dirección.

La Orden · Asociación Lúdica de Portugalete
laordenaslu@gmail.com`;
}

function html(codigo, minutos) {
  return `<!DOCTYPE html>
<html lang="es"><body style="font-family:system-ui,sans-serif;background:#0D0906;color:#F0E6D6;padding:32px;line-height:1.7">
  <p>Tu código para votar es:</p>
  <p style="font-size:2rem;letter-spacing:.35em;font-weight:700;color:#D4924A;margin:24px 0">${codigo}</p>
  <p>Caduca en ${minutos} minutos y solo se puede usar una vez. Escríbelo en la
     página de la votación para confirmar tu voto.</p>
  <p>Si no has pedido este código, no hagas nada: sin él, nadie puede votar con tu dirección.</p>
  <p style="color:#8A7560;font-size:.85rem;margin-top:32px">
     La Orden · Asociación Lúdica de Portugalete<br>
     <a href="mailto:laordenaslu@gmail.com" style="color:#D4924A">laordenaslu@gmail.com</a></p>
</body></html>`;
}

/**
 * Manda el código a `destino`, que es la dirección TAL CUAL la escribió la
 * persona — no la normalizada (§6.3).
 * @returns {Promise<boolean>} true solo si el servicio lo aceptó.
 */
export async function enviarCodigo(env, destino, codigo) {
  const remitente = env.EMAIL_REMITENTE;
  if (!remitente) return false;
  if (!env.EMAIL || typeof env.EMAIL.send !== 'function') return false;

  const minutos = Number(env.CODIGO_MINUTOS) || 10;

  try {
    await env.EMAIL.send({
      to: destino,
      from: { email: remitente, name: 'La Orden' },
      subject: ASUNTO,
      text: texto(codigo, minutos),
      html: html(codigo, minutos)
    });
    return true;
  } catch {
    // El motivo no sube: quien llama solo puede decir el mensaje neutro.
    return false;
  }
}
