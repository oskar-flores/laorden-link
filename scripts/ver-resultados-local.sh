#!/usr/bin/env bash
# Genera la página /admin/results con datos de ejemplo y la abre en el navegador.
#
#   ./scripts/ver-resultados-local.sh
#
# Por qué hace falta: en local no hay Cloudflare Access delante, así que
# /admin/results responde 403 y esa página no se puede mirar nunca. Aquí se
# llama directamente a la función que la dibuja, con las consultas SQL reales
# contra una base en memoria. NO se toca la autenticación: el 403 de
# wrangler dev sigue siendo correcto y así debe quedarse.
set -euo pipefail

RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
SALIDA="${SALIDA:-/tmp/laorden-resultados.html}"

node "$RAIZ/scripts/ver-resultados-local.mjs" > "$SALIDA"

echo "Página escrita en: $SALIDA" >&2
echo "" >&2
echo "Ábrela con:  xdg-open $SALIDA" >&2
echo "" >&2
echo "Qué mirar:" >&2
echo "  1. El recuento se lee bien y está ordenado de más a menos." >&2
echo "  2. La tabla de riesgo marca los tres tipos de bandera." >&2
echo "  3. La columna IDs trae números copiables para el comando de anular." >&2
echo "  4. Se lee en un móvil, que es donde lo vais a abrir el día 17." >&2
