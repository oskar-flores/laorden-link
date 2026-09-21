/**
 * CORS solo para desarrollo local. En producción CORS_ORIGIN está vacío,
 * el Worker comparte dominio con la página y no se emite ninguna cabecera.
 *
 * Aviso: con CORS_ORIGIN activo la cookie voter_id no viaja entre orígenes
 * (SameSite=Lax). En local la deduplicación por cookie no funcionará; la de
 * huella sí. Es una limitación asumida, no se relajan las banderas de la cookie.
 */
function allowedOrigin(request, env) {
  const origin = request.headers.get('Origin');
  if (!env.CORS_ORIGIN || !origin) return null;
  return origin === env.CORS_ORIGIN ? origin : null;
}

export function withCors(response, request, env) {
  const origin = allowedOrigin(request, env);
  if (!origin) return response;
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Vary', 'Origin');
  return new Response(response.body, { status: response.status, headers });
}

export function handlePreflight(request, env) {
  const origin = allowedOrigin(request, env);
  if (!origin) return new Response(null, { status: 404 });
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin'
    }
  });
}
