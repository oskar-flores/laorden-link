/**
 * Normalización de direcciones de correo (spec 2026-09-22 §6.3).
 *
 * Este módulo lo importan DOS consumidores: el Worker y
 * scripts/voto-asistido.sh (que lo carga con node). Dos copias derivarían, y
 * una copia derivada deja un voto asistido conviviendo con el voto web de la
 * misma persona. Si lo tocas, tócalo aquí y solo aquí.
 */

// Gmail ignora los puntos del local y todo lo que va tras un '+'. Es
// comportamiento documentado del proveedor, no una heurística: esas
// direcciones son literalmente el mismo buzón. En cualquier otro dominio, un
// punto o una etiqueta + pueden ser dos personas distintas, así que no se
// aplica allí.
const DOMINIOS_GMAIL = new Set(['gmail.com', 'googlemail.com']);

/** Longitud máxima de una dirección de correo, RFC 5321. */
export const CORREO_MAX = 254;

// Deliberadamente laxa: esto no valida direcciones, solo descarta lo que
// claramente no lo es antes de gastar un envío. La validación de verdad es
// que el código llegue al buzón.
const FORMA = /^[^\s@,;:<>"()[\]\\]+@[^\s@.,;:<>"()[\]\\]+(\.[^\s@.,;:<>"()[\]\\]+)+$/;

/** Forma plausible y longitud dentro del límite. */
export function correoValido(correo) {
  if (typeof correo !== 'string') return false;
  const limpio = correo.trim();
  if (limpio.length === 0 || limpio.length > CORREO_MAX) return false;
  return FORMA.test(limpio);
}

/** Forma canónica con la que se deduplica. El código se manda al correo TAL CUAL lo escribió la persona. */
export function normalizarCorreo(correo) {
  if (typeof correo !== 'string') return '';
  const limpio = correo.trim().toLowerCase();

  const arroba = limpio.lastIndexOf('@');
  // Sin arroba utilizable no hay dominio que mirar: se devuelve tal cual, ya
  // recortado y en minúsculas. correoValido() es quien rechaza estos casos.
  if (arroba === -1) return limpio;

  let local = limpio.slice(0, arroba);
  const dominio = limpio.slice(arroba + 1);
  if (!DOMINIOS_GMAIL.has(dominio)) return `${local}@${dominio}`;

  const mas = local.indexOf('+');
  if (mas !== -1) local = local.slice(0, mas);
  local = local.replace(/\./g, '');
  return `${local}@${dominio}`;
}
