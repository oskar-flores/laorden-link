#!/usr/bin/env bash
# Levanta el sitio entero en local con la votación ABIERTA, para poder probar
# el flujo de voto en un navegador de verdad antes del 11 de octubre.
#
#   ./scripts/probar-local.sh
#
# Por qué hace falta: en wrangler.toml la votación abre el 11 de octubre, así
# que en un arranque normal el servidor rechaza todo voto con un 403 y el modal
# no se puede probar. Aquí se sobreescriben las fechas solo para esta sesión;
# no se toca ningún fichero.
set -euo pipefail

RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
PUERTO="${PUERTO:-8787}"
SECRETOS="$RAIZ/worker/.dev.vars"

# Cloudflare publica un secreto de Turnstile que siempre acepta. La página usa
# su clave pública equivalente cuando detecta localhost.
if [ ! -f "$SECRETOS" ]; then
  echo "Creando worker/.dev.vars (ignorado por git, no es ningún secreto real)" >&2
  cat > "$SECRETOS" <<'VARS'
IP_SALT=sal-solo-para-desarrollo-local-no-es-un-secreto
TURNSTILE_SECRET=1x0000000000000000000000000000000AA
VARS
fi

ESTADO="/tmp/laorden-wrangler-state"

# Un wrangler de una sesión anterior deja el puerto cogido y el error que suelta
# workerd es una traza ilegible. Mejor decirlo claro.
if (command -v ss >/dev/null && ss -ltn 2>/dev/null | grep -q ":$PUERTO ") \
   || (command -v lsof >/dev/null && lsof -i ":$PUERTO" >/dev/null 2>&1); then
  cat >&2 <<AVISO

  El puerto $PUERTO ya está ocupado, probablemente por otro wrangler abierto.
  Ciérralo, o usa otro puerto:   PUERTO=8788 ./scripts/probar-local.sh

AVISO
  exit 1
fi

# La base local arranca vacía: sin esto el primer voto muere con
# "no such table: votes". Es idempotente, se puede repetir sin miedo.
echo "Aplicando migraciones a la base local..." >&2
(cd "$RAIZ/worker" && npx wrangler d1 migrations apply laorden-votos \
    --local --persist-to "$ESTADO" >/dev/null 2>&1) \
  || { echo "No se han podido aplicar las migraciones locales." >&2; exit 1; }

ABRE="$(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%SZ)"
CIERRA="$(date -u -d '+30 days' +%Y-%m-%dT%H:%M:%SZ)"

cat >&2 <<INFO

  Votación FORZADA ABIERTA solo en esta sesión
    abre:   $ABRE
    cierra: $CIERRA

  Galería      http://localhost:$PUERTO/concurso/votacion.html
  Privacidad   http://localhost:$PUERTO/concurso/privacidad.html
  Estado API   http://localhost:$PUERTO/api/status

  Qué comprobar en el navegador (nada de esto lo ha visto nadie todavía):
    1. La rejilla en móvil y en escritorio.
    2. Votar entero. El widget de Turnstile debe dibujarse y pasar solo.
    3. Votar otra vez: debe decir que ya has votado.
    4. Teclado: Tab por la rejilla, abrir modal, Tab y Shift+Tab dentro, Escape.
    5. Doble clic rápido en Confirmar.
    6. Con uBlock Origin puesto: debe dejarte votar igual.
    7. Bloquear challenges.cloudflare.com: debe salir un mensaje en castellano,
       no un botón muerto y mudo.

  Para empezar de cero (borra los votos de prueba):
    rm -rf /tmp/laorden-wrangler-state  y vuelve a lanzar esto

  Ctrl-C para parar.

INFO

cd "$RAIZ/worker"
exec npx wrangler dev \
  --assets .. \
  --persist-to "$ESTADO" \
  --port "$PUERTO" \
  --var "VOTING_OPEN:$ABRE" \
  --var "VOTING_CLOSE:$CIERRA"
