import { createRemoteJWKSet, jwtVerify } from 'jose';

const jwksCache = new Map();

function jwksFor(teamDomain) {
  if (!jwksCache.has(teamDomain)) {
    jwksCache.set(
      teamDomain,
      createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`))
    );
  }
  return jwksCache.get(teamDomain);
}

/**
 * Defensa en profundidad (§9): Access ya protege la ruta en el panel, pero si
 * esa configuración estuviera mal, esta verificación es lo único que impide
 * que el recuento se filtre antes del día 17.
 */
export async function verifyAccessJwt(request, env) {
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return { ok: false };

  try {
    const { payload } = await jwtVerify(token, jwksFor(env.ACCESS_TEAM_DOMAIN), {
      issuer: `https://${env.ACCESS_TEAM_DOMAIN}`,
      audience: env.ACCESS_AUD
    });
    return { ok: true, email: payload.email || '' };
  } catch {
    return { ok: false };
  }
}
