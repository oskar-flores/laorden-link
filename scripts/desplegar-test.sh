#!/usr/bin/env bash
# Despliega la rama en test.laorden.org y comprueba que no se ha publicado de
# más.
#
#   ./scripts/desplegar-test.sh
#
# Qué es este entorno: un Worker aparte (laorden-votos-test) que sirve el sitio
# entero —páginas y API— con la votación forzada abierta y su propia base de
# datos. Sirve para mirar en un navegador de verdad, sobre HTTPS, lo que en
# local solo se puede ver con probar-local.sh. La configuración está en
# worker/wrangler.toml, bloque [env.test].
#
# Antes de la primera vez hace falta, una sola vez, lo que no puede hacer este
# script porque vive en vuestra cuenta de Cloudflare:
#
#   cd worker
#   npx wrangler login
#   npx wrangler d1 create laorden-votos-test   # y pega el id en [env.test]
#   openssl rand -hex 32 | npx wrangler secret put IP_SALT --env test
#   npx wrangler secret put TURNSTILE_SECRET --env test
#
# Más, en el panel: el widget de Turnstile con test.laorden.org entre sus
# dominios, y una aplicación de Access sobre test.laorden.org/admin. El AUD de
# esa aplicación va en ACCESS_AUD de [env.test] — el de test, no el de
# producción.
set -euo pipefail

RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${HOST:-test.laorden.org}"
WRANGLER="$RAIZ/worker/wrangler.toml"

# Con SOLO_COMPROBAR=1 no se despliega nada: solo se repasa lo que ya está en
# pie. Útil en el primer despliegue, cuando el certificado del dominio nuevo
# todavía no ha propagado y las comprobaciones fallan por eso.
if [ -n "${SOLO_COMPROBAR:-}" ]; then
  cd "$RAIZ/worker"
elif grep -A4 '^\[\[env.test.d1_databases\]\]' "$WRANGLER" | grep -q 'database_id = "PENDIENTE"'; then
  cat >&2 <<AVISO

  El entorno de test no tiene base de datos todavía.

    cd worker && npx wrangler d1 create laorden-votos-test

  Copia el database_id que imprime al bloque [[env.test.d1_databases]] de
  worker/wrangler.toml y vuelve a lanzar esto.

AVISO
  exit 1
fi

if [ -z "${SOLO_COMPROBAR:-}" ]; then
  cd "$RAIZ/worker"

  if ! npx wrangler whoami >/dev/null 2>&1; then
    echo "wrangler no está autenticado. Lanza:  cd worker && npx wrangler login" >&2
    exit 1
  fi

  echo "Aplicando migraciones a laorden-votos-test..." >&2
  npx wrangler d1 migrations apply laorden-votos-test --env test --remote

  echo "Desplegando el entorno de test..." >&2
  npx wrangler deploy --env test
fi

# ── Comprobaciones ───────────────────────────────────────────────────────────
# Cloudflare tarda unos segundos en tener el certificado del dominio nuevo la
# primera vez. Si todo esto falla en el primer despliegue, espera y repite solo
# esta parte:  SOLO_COMPROBAR=1 ./scripts/desplegar-test.sh
codigo() { curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://$HOST$1" || echo 000; }

fallos=0
mal() { echo "  ✗ $1" >&2; fallos=$((fallos + 1)); }
bien() { echo "  ✓ $1" >&2; }

echo "" >&2
echo "Comprobando https://$HOST" >&2

# La primera y la más importante. El despliegue sube lo que hay en el DISCO,
# no lo que hay en git: docs/ lleva correos personales y fotos-originales/
# lleva EXIF. Lo único que los separa de una URL pública es .assetsignore.
echo "" >&2
echo "Nada de lo que no debe salir, ha salido:" >&2
for ruta in \
  /docs/superpowers/traspaso-votacion-tarea-6.md \
  /worker/wrangler.toml \
  /worker/.dev.vars \
  /.assetsignore
do
  c="$(codigo "$ruta")"
  if [ "$c" = "200" ]; then
    mal "$ruta responde 200 — ESTÁ PUBLICADO. Revisa .assetsignore y vuelve a desplegar antes de dar esta URL a nadie."
  else
    bien "$ruta → $c"
  fi
done

echo "" >&2
echo "El sitio y la API:" >&2
# El enrutado de assets quita el .html y redirige: /concurso/votacion.html
# acaba en /concurso/votacion con un 307. En producción lo sirve GitHub Pages
# sin redirigir, así que las URLs de los dos entornos no son idénticas; la
# página sí. Por eso aquí se sigue la redirección y se mira el contenido, que
# dice bastante más que el código de estado.
galeria="$(curl -sL --max-time 20 "https://$HOST/concurso/votacion.html" || true)"
if echo "$galeria" | grep -q '<title>Premio del público'; then
  bien "la galería carga"
else
  mal "la galería no carga (responde $(codigo /concurso/votacion.html) y, siguiendo la redirección, no aparece su título)"
fi

# Si la clave pública de Turnstile llegara sin rellenar, el widget no se
# dibujaría y no se podría votar: el fallo se vería en el navegador y no aquí.
if echo "$galeria" | grep -q "TURNSTILE_KEY = 'PENDIENTE'"; then
  mal "la página se sirve con TURNSTILE_KEY = 'PENDIENTE': el widget no se dibujará"
else
  bien "la página lleva su clave de Turnstile"
fi

estado="$(curl -s --max-time 15 "https://$HOST/api/status" || true)"
if echo "$estado" | grep -q '"open": *true'; then
  bien "la votación está abierta (es lo que queremos aquí, no en www)"
else
  mal "/api/status no dice que esté abierta: $estado"
fi

# 500 aquí significa que falta IP_SALT: el código falla cerrado a propósito.
voto="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST \
  -H 'Content-Type: application/json' \
  -d '{"mini_code":"07","fingerprint":"x","turnstile_token":"x"}' \
  "https://$HOST/api/vote" || echo 000)"
case "$voto" in
  500) mal "/api/vote devuelve 500: falta el secreto IP_SALT en este entorno (npx wrangler secret put IP_SALT --env test)" ;;
  40*) bien "/api/vote rechaza un token falso de Turnstile ($voto)" ;;
  *)   mal "/api/vote responde $voto, que no es lo esperado" ;;
esac

c="$(codigo /admin/results)"
case "$c" in
  302|403) bien "el panel pide Access ($c)" ;;
  200)     mal "el panel responde 200 SIN Access: el recuento está al aire. Revisa la aplicación de Access de $HOST." ;;
  *)       mal "el panel responde $c" ;;
esac

echo "" >&2
if [ "$fallos" -gt 0 ]; then
  echo "  $fallos comprobación(es) fallaron. No repartas la URL hasta arreglarlas." >&2
  exit 1
fi

cat >&2 <<INFO

  Todo en orden. https://$HOST

  Lo que hay que mirar aquí y no se puede mirar en local:

    1. Turnstile de verdad, con la clave real y sobre HTTPS.
    2. El modal y la rejilla en un móvil de verdad, no en un navegador
       encogido.
    3. Votar entero, y votar otra vez: debe decir que ya has votado.
    4. El panel /admin/results entrando con uno de los tres correos, y que
       las miniaturas de las obras se ven (si ya hay fotos).
    5. Con uBlock Origin puesto: debe dejarte votar igual.

  Los votos de esta base son de mentira y no tocan el recuento real: son dos
  bases distintas. Para vaciarla:

    cd worker && npx wrangler d1 execute laorden-votos-test --env test \\
      --remote --command "DELETE FROM votes"

INFO
