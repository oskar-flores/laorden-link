import { hmacHex } from './crypto.js';

/**
 * Códigos de verificación de seis dígitos (spec 2026-09-22 §6.1).
 *
 * Un millón de combinaciones es trivial de romper por fuerza bruta desde un
 * volcado de la base, SALVO que la clave del HMAC viva fuera de ella. Vive
 * fuera: es IP_SALT, un secreto del Worker que nunca toca la base.
 */

/** Seis dígitos, con los ceros a la izquierda. '000042' es un código válido. */
export function generarCodigo() {
  const buf = new Uint32Array(1);
  // Rechazo por encima del último múltiplo de un millón: sin esto, los
  // códigos bajos saldrían un pelín más a menudo. El sesgo sería minúsculo,
  // pero evitarlo cuesta tres líneas.
  const limite = Math.floor(4294967296 / 1000000) * 1000000;
  let v;
  do {
    crypto.getRandomValues(buf);
    v = buf[0];
  } while (v >= limite);
  return String(v % 1000000).padStart(6, '0');
}

/** El código nunca se guarda en claro: solo este HMAC. */
export async function hashCodigo(salt, emailNorm, codigo) {
  return hmacHex(salt, `codigo:${emailNorm}:${codigo}`);
}
