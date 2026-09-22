export const VOTER_COOKIE = 'voter_id';

/** Lee una cookie concreta de la petición. Devuelve null si no está. */
export function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1);
  }
  return null;
}

/** Cookie de primera parte: el sitio y el Worker comparten dominio (spec §4). */
export function serialiseVoterCookie(voterId) {
  return `${VOTER_COOKIE}=${voterId}; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000; Path=/`;
}
