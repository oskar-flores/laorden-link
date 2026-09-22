export async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Un IP_SALT ausente hace que `${ip}${salt}` sea `${ip}undefined`: la promesa
// de privacidad.html ("solo un hash irreversible") se vuelve falsa sin que
// nada lo note, porque un SHA-256 sin sal de una IPv4 se invierte por fuerza
// bruta en segundos (2^32 direcciones). 12 es un suelo bajo a propósito: un
// secreto real (`wrangler secret put IP_SALT` con `openssl rand -hex 32`,
// 64 caracteres) lo supera de sobra; esto solo existe para atrapar el secreto
// ausente o vacío, no como comprobación de fuerza criptográfica.
export const IP_SALT_MIN_LENGTH = 12;

/** ¿Hay un IP_SALT utilizable? Falla cerrado si no lo hay (G1). */
export function saltIsUsable(salt) {
  return typeof salt === 'string' && salt.length >= IP_SALT_MIN_LENGTH;
}

/** La IP cruda no se almacena jamás (§12), solo su hash con sal. */
export async function hashIp(ip, salt) {
  return sha256Hex(`${ip}${salt}`);
}

export function newVoterId() {
  return crypto.randomUUID();
}
