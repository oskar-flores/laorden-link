#!/usr/bin/env bash
# Despliega la rama del voto por correo en test-correo.laorden.org y comprueba
# que no se ha publicado de más.
#
#   ./scripts/desplegar-correo.sh
#
# Qué es este entorno: un Worker aparte (laorden-votos-correo) que sirve el
# sitio entero —páginas y API— con la votación forzada abierta, su propia base
# y su propio binding de correo. Existe para poder enseñar los DOS sistemas a
# la vez: el anónimo en test.laorden.org y este, y mirar en qué paso abandona
# la gente (spec 2026-09-22 §12.1 y §14).
#
# Antes de la primera vez hace falta, una sola vez, lo que no puede hacer este
# script porque vive en vuestra cuenta de Cloudflare:
#
#   cd worker
#   npx wrangler login
#   npx wrangler d1 create laorden-votos-correo   # y pega el id en [env.correo]
#   openssl rand -hex 32 | npx wrangler secret put IP_SALT --env correo
#   npx wrangler secret put TURNSTILE_SECRET --env correo
#
# Más, en el panel: el dominio remitente verificado en Cloudflare Email
# Service, y una aplicación de Access sobre test-correo.laorden.org/admin. El
# AUD de ESA aplicación va en ACCESS_AUD de [env.correo].
set -euo pipefail

RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${HOST:-test-correo.laorden.org}"
WRANGLER="$RAIZ/worker/wrangler.toml"

# Los dos entornos viven en el mismo wrangler.toml, así que un --env
# equivocado sobreescribe el otro despliegue y destruye la comparación.
RAMA_ESPERADA="feature/voto-verificado-correo"
RAMA="$(cd "$RAIZ" && git rev-parse --abbrev-ref HEAD)"
if [ "$RAMA" != "$RAMA_ESPERADA" ] && [ -z "${FORZAR_RAMA:-}" ]; then
  cat >&2 <<AVISO

  test-correo.laorden.org sirve el voto verificado por correo, y se despliega
  desde $RAMA_ESPERADA. Estás en $RAMA.

  Si de verdad sabes lo que haces:  FORZAR_RAMA=1 ./scripts/desplegar-correo.sh

AVISO
  exit 1
fi

if [ -n "${SOLO_COMPROBAR:-}" ]; then
  cd "$RAIZ/worker"
elif grep -A4 '^\[\[env.correo.d1_databases\]\]' "$WRANGLER" | grep -q 'database_id = "PENDIENTE"'; then
  cat >&2 <<AVISO

  El entorno del correo no tiene base de datos todavía.

    cd worker && npx wrangler d1 create laorden-votos-correo

  Copia el database_id que imprime al bloque [[env.correo.d1_databases]] de
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

  echo "Aplicando migraciones a laorden-votos-correo..." >&2
  npx wrangler d1 migrations apply laorden-votos-correo --env correo --remote

  echo "Desplegando el entorno del correo..." >&2
  npx wrangler deploy --env correo
fi

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
  /docs/superpowers/plans/2026-09-22-voto-verificado-correo.md \
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
galeria="$(curl -sL --max-time 20 "https://$HOST/concurso/votacion.html" || true)"
if echo "$galeria" | grep -q '<title>Premio del público'; then
  bien "la galería carga"
else
  mal "la galería no carga (responde $(codigo /concurso/votacion.html))"
fi

# Si quedara huella, el aviso de privacidad y el código dirían cosas distintas.
if echo "$galeria" | grep -qi 'fingerprint\|jsdelivr'; then
  mal "la página todavía carga FingerprintJS: debía haberse ido entera"
else
  bien "no queda rastro de la huella"
fi

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
cod="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST \
  -H 'Content-Type: application/json' \
  -d '{"correo":"prueba@ejemplo.com","turnstile_token":"x"}' \
  "https://$HOST/api/code" || echo 000)"
case "$cod" in
  500) mal "/api/code devuelve 500: falta IP_SALT (npx wrangler secret put IP_SALT --env correo)" ;;
  403) bien "/api/code rechaza un token falso de Turnstile (403)" ;;
  *)   mal "/api/code responde $cod, que no es lo esperado" ;;
esac

voto="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST \
  -H 'Content-Type: application/json' \
  -d '{"mini_code":"07","correo":"prueba@ejemplo.com","codigo":"000000"}' \
  "https://$HOST/api/vote" || echo 000)"
case "$voto" in
  500) mal "/api/vote devuelve 500: falta IP_SALT en este entorno" ;;
  400) bien "/api/vote rechaza un código inventado (400)" ;;
  *)   mal "/api/vote responde $voto, que no es lo esperado" ;;
esac

c="$(codigo /admin/results)"
case "$c" in
  302|403) bien "el panel pide Access ($c)" ;;
  200)     mal "el panel responde 200 SIN Access: el recuento y los CORREOS están al aire. Revisa la aplicación de Access de $HOST." ;;
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

    1. Que el correo LLEGA, y a qué carpeta. Gmail, Hotmail, Outlook y un
       dominio corporativo, mirando spam en los cuatro. Todos los días, no una
       vez: se está construyendo historial de envío además de medir.
    2. El modal de dos pasos en un móvil de verdad.
    3. Votar entero, y votar otra vez con la misma dirección: debe decir que
       ya has votado.
    4. La misma dirección con puntos y con +: debe seguir siendo un solo voto.
    5. El panel /admin/results: la línea de cuota, los correos en la tabla de
       orígenes y la sección de votos asistidos.
    6. Y lo que más vale de todo: poner ESTA url y la de test.laorden.org
       delante de las mismas cinco personas y mirar dónde abandonan. El flujo
       del correo tiene cuatro pasos y una espera; el otro, uno y una casilla.

  Los votos de esta base son de mentira y no tocan el recuento real. Para
  vaciarla:

    cd worker && npx wrangler d1 execute laorden-votos-correo --env correo \\
      --remote --command "DELETE FROM votes"
    cd worker && npx wrangler d1 execute laorden-votos-correo --env correo \\
      --remote --command "DELETE FROM codigos"

INFO
