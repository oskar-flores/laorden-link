import { verifyAccessJwt } from '../lib/access.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const TALLY = `
  SELECT mini_code, COUNT(*) AS c FROM votes
  WHERE status = 'valid' GROUP BY mini_code ORDER BY c DESC`;

// Votos que caben en esta ventana, desde un mismo origen, para que cuente
// como ráfaga. Una familia que vota desde el mismo wifi lo hace a lo largo de
// la tarde; una sola persona cambiando de navegador (Safari, Brave, ventana
// privada) lo hace en cuatro minutos, porque la cookie y la huella son POR
// NAVEGADOR y no la frenan. Es la bandera que separa esos dos casos, y la
// única que mira el tiempo.
const RAFAGA_VOTOS = 3;
const RAFAGA_MINUTOS = 10;

// El HAVING lista TODOS los orígenes con más de un voto, no solo los
// marcados: tres votos a tres obras distintas desde el mismo móvil no
// disparan ninguna bandera y siguen siendo tres votos de una persona. La
// bandera ordena la revisión, no es la condición para aparecer. Un voto único
// desde datacenter sí entra, porque ahí el volumen no es la señal.
//
// Sin comentarios ni ';' dentro de la plantilla, a propósito: esta consulta se
// pega a mano en `wrangler d1 execute`, que la aplana en una línea y la parte
// por los ';'. Un comentario ahí dentro se tragaría el HAVING sin dar error.
export const RISK = `
  SELECT ip_hash, asn_name, COUNT(*) AS votos,
         COUNT(DISTINCT mini_code) AS obras_distintas,
         GROUP_CONCAT(id) AS ids,
         MIN(created_at) AS primero, MAX(created_at) AS ultimo,
         (COUNT(*) > 5)                                   AS f_volumen,
         (asn_name LIKE '%Hosting%' OR asn_name LIKE '%Cloud%'
          OR asn_name LIKE '%VPN%')                       AS f_datacenter,
         (COUNT(*) > 3 AND COUNT(DISTINCT mini_code) = 1) AS f_concentrado,
         (COUNT(*) >= ${RAFAGA_VOTOS} AND
          (julianday(MAX(created_at)) - julianday(MIN(created_at))) * 1440
            < ${RAFAGA_MINUTOS})                          AS f_rafaga
  FROM votes WHERE status = 'valid'
  GROUP BY ip_hash, asn_name
  HAVING votos > 1 OR f_datacenter
  ORDER BY (f_volumen OR f_datacenter OR f_concentrado OR f_rafaga) DESC,
           votos DESC, ultimo DESC`;

/**
 * Construye, a partir del manifiesto de obras.json ya parseado, un índice
 * `code -> { img, thumb }` con las URLs de imagen resueltas contra `baseUrl`.
 *
 * Pura y sin E/S: quien llama decide de dónde viene el manifiesto (el
 * `fetch` del Worker, o la lectura de fichero de ver-resultados-local.mjs) y
 * qué `baseUrl` usar. Las rutas de dentro de obras.json son relativas a
 * `/concurso/` (p. ej. "obras/07.webp"), así que `baseUrl` debe apuntar a
 * "algo/concurso/obras.json" (real o file://) para que `new URL(...)` las
 * resuelva al sitio correcto.
 */
export function buildObrasIndex(lista, baseUrl) {
  const indice = new Map();
  if (!Array.isArray(lista)) return indice;
  for (const obra of lista) {
    if (!obra || obra.code == null) continue;
    const entrada = {};
    if (obra.img) entrada.img = new URL(obra.img, baseUrl).href;
    if (obra.thumb) entrada.thumb = new URL(obra.thumb, baseUrl).href;
    indice.set(String(obra.code), entrada);
  }
  return indice;
}

export function page(totals, tally, risk, email, obras = new Map()) {
  const banderas = (r) => [
    r.f_volumen ? 'volumen' : null,
    r.f_datacenter ? 'datacenter' : null,
    r.f_concentrado ? 'concentrado' : null,
    r.f_rafaga ? 'ráfaga' : null
  ].filter(Boolean).join(', ') || '—';

  const miniatura = (r) => {
    const obra = obras.get(String(r.mini_code));
    if (!obra || !obra.img) return '';
    const thumb = obra.thumb || obra.img;
    return `<br><a href="${esc(obra.img)}"><img class="miniatura" src="${esc(thumb)}" alt="Obra ${esc(r.mini_code)}" loading="lazy"></a>`;
  };

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
  .miniatura { max-width:120px; max-height:120px; width:auto; height:auto;
               display:block; margin-top:4px; border-radius:4px; }
</style></head><body>
<h1>Resultados I Concurso de Pintura</h1>
<p class="aviso">Sesión: ${esc(email)} · Votos válidos: <strong>${totals}</strong></p>

<h2>Recuento</h2>
<table><tr><th>Obra</th><th>Votos</th></tr>
${tally.map((r) => `<tr><td>#${esc(r.mini_code)}${miniatura(r)}</td><td>${r.c}</td></tr>`).join('')}
</table>

<h2>Orígenes con más de un voto</h2>
<p class="aviso">Aparecen todos, marcados o no. Una bandera dice qué mirar
primero, no que haya fraude: dos votos del mismo wifi suelen ser dos personas
de la misma casa. <strong>ráfaga</strong> es la más discriminante — varios
votos seguidos en minutos desde un mismo origen es lo que hace una sola
persona cambiando de navegador.</p>
${risk.length === 0 ? '<p class="aviso">Ningún origen repite voto.</p>' : `
<table><tr><th>Hash IP</th><th>Red</th><th>Votos</th><th>Obras</th><th>Primero</th><th>Último</th><th>Banderas</th><th>IDs</th></tr>
${risk.map((r) => `<tr>
  <td><code>${esc(String(r.ip_hash).slice(0, 12))}…</code></td>
  <td>${esc(r.asn_name)}</td><td>${r.votos}</td><td>${r.obras_distintas}</td>
  <td>${esc(r.primero)}</td><td>${esc(r.ultimo)}</td><td>${esc(banderas(r))}</td>
  <td><code>${esc(r.ids)}</code></td>
</tr>`).join('')}
</table>`}

<p class="aviso">Página de solo lectura.</p>
</body></html>`;
}

/**
 * Lee concurso/obras.json para saber qué obras tienen foto. Si la petición
 * falla o el fichero no es el esperado, se devuelve un índice vacío: el
 * recuento tiene que salir igual, solo que sin miniaturas (ver brief de la
 * Tarea 3). Se resuelve contra `request.url` para que funcione tanto en
 * producción (GitHub Pages) como en `wrangler dev` (--assets).
 */
async function cargarObras(request) {
  try {
    const manifiestoUrl = new URL('/concurso/obras.json', request.url);
    const res = await fetch(manifiestoUrl);
    if (!res.ok) return new Map();
    const lista = await res.json();
    const indice = buildObrasIndex(lista, manifiestoUrl);
    // buildObrasIndex() resuelve contra manifiestoUrl y devuelve URLs
    // absolutas (con esquema y host). En el Worker interesa la ruta relativa
    // al sitio ("/concurso/obras/07.webp"), no repetir el host: así la
    // página se ve igual en producción (www.laorden.org) y en wrangler dev.
    for (const entrada of indice.values()) {
      if (entrada.img) entrada.img = new URL(entrada.img).pathname;
      if (entrada.thumb) entrada.thumb = new URL(entrada.thumb).pathname;
    }
    return indice;
  } catch {
    return new Map();
  }
}

export async function handleAdminResults(request, env) {
  const auth = await verifyAccessJwt(request, env);
  if (!auth.ok) {
    return new Response('Acceso denegado.', {
      status: 403,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
    });
  }

  const [tally, risk, totals, obras] = await Promise.all([
    env.DB.prepare(TALLY).all(),
    env.DB.prepare(RISK).all(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM votes WHERE status = 'valid'").first(),
    cargarObras(request)
  ]);

  return new Response(page(totals.n, tally.results, risk.results, auth.email, obras), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}
