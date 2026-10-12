const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Devuelve true solo si Cloudflare confirma el token. Cualquier fallo → false. */
export async function verifyTurnstile(token, secret, remoteIp) {
  if (!token) return false;

  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);
  if (remoteIp) form.append('remoteip', remoteIp);

  try {
    const res = await fetch(SITEVERIFY, { method: 'POST', body: form });
    if (!res.ok) return false;
    const data = await res.json();
    return data.success === true;
  } catch {
    return false;
  }
}
