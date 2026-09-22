import { verifyAccessJwt } from '../lib/access.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const TALLY = `
  SELECT mini_code, COUNT(*) AS c FROM votes
  WHERE status = 'valid' GROUP BY mini_code ORDER BY c DESC`;

const RISK = `
  SELECT ip_hash, asn_name, COUNT(*) AS votos,
         COUNT(DISTINCT mini_code) AS obras_distintas,
         GROUP_CONCAT(id) AS ids,
         MIN(created_at) AS primero, MAX(created_at) AS ultimo,
         (COUNT(*) > 5)                                   AS f_volumen,
         (asn_name LIKE '%Hosting%' OR asn_name LIKE '%Cloud%'
          OR asn_name LIKE '%VPN%')                       AS f_datacenter,
         (COUNT(*) > 3 AND COUNT(DISTINCT mini_code) = 1) AS f_concentrado
  FROM votes WHERE status = 'valid'
  GROUP BY ip_hash, asn_name
  HAVING f_volumen OR f_datacenter OR f_concentrado
  ORDER BY votos DESC`;

function page(totals, tally, risk, email) {
  const banderas = (r) => [
    r.f_volumen ? 'volumen' : null,
    r.f_datacenter ? 'datacenter' : null,
    r.f_concentrado ? 'concentrado' : null
  ].filter(Boolean).join(', ');

  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Resultados · La Orden</title>
<style>
  body { font-family: system-ui, sans-serif; background:#0D0906; color:#F0E6D6;
         margin:0; padding:32px; line-height:1.6; }
  h1,h2 { font-weight:600; color:#D4924A; }
  table { border-collapse:collapse; width:100%; max-width:900px; margin-bottom:40px; }
  th,td { text-align:left; padding:8px 12px; border-bottom:1px solid rgba(196,120,50,0.2); }
  th { color:#8A7560; font-weight:500; }
  .aviso { color:#8A7560; font-size:0.9em; max-width:60ch; }
  code { background:rgba(255,255,255,0.05); padding:2px 5px; }
</style></head><body>
<h1>Resultados — I Concurso de Pintura</h1>
<p class="aviso">Sesión: ${esc(email)} · Votos válidos: <strong>${totals}</strong></p>

<h2>Recuento</h2>
<table><tr><th>Obra</th><th>Votos</th></tr>
${tally.map((r) => `<tr><td>#${esc(r.mini_code)}</td><td>${r.c}</td></tr>`).join('')}
</table>

<h2>Revisión de riesgo (§10)</h2>
${risk.length === 0 ? '<p class="aviso">Ningún origen marcado.</p>' : `
<table><tr><th>Hash IP</th><th>Red</th><th>Votos</th><th>Obras</th><th>Primero</th><th>Último</th><th>Banderas</th><th>IDs</th></tr>
${risk.map((r) => `<tr>
  <td><code>${esc(String(r.ip_hash).slice(0, 12))}…</code></td>
  <td>${esc(r.asn_name)}</td><td>${r.votos}</td><td>${r.obras_distintas}</td>
  <td>${esc(r.primero)}</td><td>${esc(r.ultimo)}</td><td>${esc(banderas(r))}</td>
  <td><code>${esc(r.ids)}</code></td>
</tr>`).join('')}
</table>`}

<p class="aviso">Página de solo lectura. Anular un voto es una decisión deliberada
y se hace por CLI, con un id de la columna <strong>IDs</strong> de arriba:<br>
<code>wrangler d1 execute laorden-votos --remote --command "UPDATE votes SET status='annulled', annul_reason='...' WHERE id=123"</code><br>
Anular devuelve a esa persona la posibilidad de votar y libera cupo del cortafuegos por IP.</p>
</body></html>`;
}

export async function handleAdminResults(request, env) {
  const auth = await verifyAccessJwt(request, env);
  if (!auth.ok) {
    return new Response('Acceso denegado.', {
      status: 403,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
    });
  }

  const [tally, risk, totals] = await Promise.all([
    env.DB.prepare(TALLY).all(),
    env.DB.prepare(RISK).all(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM votes WHERE status = 'valid'").first()
  ]);

  return new Response(page(totals.n, tally.results, risk.results, auth.email), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}
