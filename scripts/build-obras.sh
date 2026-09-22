#!/usr/bin/env bash
# Procesa las fotos del concurso y regenera concurso/obras.json.
#
#   1. Deja las fotos en  fotos-originales/  con el nombre del código: 01.jpg, 02.jpg…
#   2. Ejecuta:  ./scripts/build-obras.sh
#
# El número de obras sale solo: es el código más alto que haya en
# fotos-originales/ (07.jpg, 22.jpg… → 22). Si aún no están todas las fotos,
# se puede forzar:  TOTAL=35 ./scripts/build-obras.sh  — las que falten salen
# con marcador, como siempre.
#
# El script también actualiza MINI_COUNT en worker/wrangler.toml al mismo
# número, para que la galería y el Worker nunca se desincronicen.
#
# Requiere ImageMagick:  sudo apt install imagemagick webp
set -euo pipefail

RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
ORIGEN="$RAIZ/fotos-originales"
DESTINO="$RAIZ/concurso/obras"
MANIFIESTO="$RAIZ/concurso/obras.json"
WRANGLER="$RAIZ/worker/wrangler.toml"
FORZADO="${TOTAL:-}"

# Si el script muere a medias (foto corrupta, Ctrl-C, sed sin permisos...) no
# se queda ni el temporal del manifiesto ni el .bak de wrangler.toml sueltos.
# En el camino bueno ya se han movido o borrado antes de llegar aquí.
trap 'rm -f "$MANIFIESTO.tmp" "$WRANGLER.bak"' EXIT

if ! command -v magick >/dev/null && ! command -v convert >/dev/null; then
  echo "Falta ImageMagick. Instálalo con: sudo apt install imagemagick webp" >&2
  exit 1
fi
MAGICK="$(command -v magick || command -v convert)"

# Código más alto encontrado en fotos-originales/ (07.jpg, 22.png… → 7, 22).
# El "10#" evita que bash lea "08" o "09" como octal inválido.
detectar_total() {
  local max=0 encontrado=0 f base nombre num
  if [ -d "$ORIGEN" ]; then
    for f in "$ORIGEN"/*; do
      [ -f "$f" ] || continue
      base="$(basename "$f")"
      nombre="${base%.*}"
      if [[ "$nombre" =~ ^[0-9]+$ ]]; then
        num=$((10#$nombre))
        encontrado=1
        [ "$num" -gt "$max" ] && max=$num
      fi
    done
  fi
  [ "$encontrado" -eq 1 ] && echo "$max" || echo 0
}

if [ -n "$FORZADO" ]; then
  if ! [[ "$FORZADO" =~ ^[0-9]+$ ]]; then
    echo "TOTAL='$FORZADO' no es un número. Uso: TOTAL=35 ./scripts/build-obras.sh" >&2
    exit 1
  fi
  # 10# de base explícita: sin esto, un TOTAL con cero delante (ej. "007")
  # bash lo interpretaría como octal y podría reventar la aritmética.
  TOTAL=$((10#$FORZADO))
  if [ "$TOTAL" -eq 0 ]; then
    echo "TOTAL=0 no vale: no hay ninguna obra que generar. Si es que no hay fotos todavía, no fuerces TOTAL y el script lo dirá solo sin tocar nada." >&2
    exit 1
  fi
else
  TOTAL="$(detectar_total)"
  if [ "$TOTAL" -eq 0 ]; then
    echo "No hay fotos en $ORIGEN (o TOTAL=N para forzarlo). No se toca $MANIFIESTO ni $WRANGLER." >&2
    exit 0
  fi
fi

if [ "$TOTAL" -gt 99 ]; then
  echo "TOTAL=$TOTAL no vale: los códigos de obra son de dos dígitos (01-99) y este concurso no tiene un caso real por encima de eso. Revisa fotos-originales/ o el valor de TOTAL forzado." >&2
  exit 1
fi

mkdir -p "$DESTINO"
: > "$MANIFIESTO.tmp"
echo "[" >> "$MANIFIESTO.tmp"

for n in $(seq 1 "$TOTAL"); do
  # Padding fijo a dos dígitos: "seq -w" solo rellena a la anchura del mayor
  # número del rango (con TOTAL=7 daría "1".."7" sin cero delante), y aquí el
  # código de dos dígitos es un invariante del repo, no un detalle estético.
  i="$(printf '%02d' "$n")"
  ORIGINAL="$(find "$ORIGEN" -maxdepth 1 -name "$i.*" 2>/dev/null | head -1 || true)"

  if [ -n "$ORIGINAL" ]; then
    # -strip elimina los EXIF: pueden llevar fecha, lugar o nombre del autor,
    # y las bases (§8) exigen anonimato.
    "$MAGICK" "$ORIGINAL" -auto-orient -strip -resize '1200x1200>' \
        -quality 82 "$DESTINO/$i.webp"
    "$MAGICK" "$ORIGINAL" -auto-orient -strip -resize '400x400>' \
        -quality 80 "$DESTINO/$i-thumb.webp"
    printf '  { "code": "%s", "img": "obras/%s.webp", "thumb": "obras/%s-thumb.webp" }' \
        "$i" "$i" "$i" >> "$MANIFIESTO.tmp"
    echo "  $i → procesada" >&2
  else
    printf '  { "code": "%s" }' "$i" >> "$MANIFIESTO.tmp"
    echo "  $i → sin foto (se mostrará el marcador)" >&2
  fi

  if [ "$n" -ne "$TOTAL" ]; then echo "," >> "$MANIFIESTO.tmp"; else echo "" >> "$MANIFIESTO.tmp"; fi
done

echo "]" >> "$MANIFIESTO.tmp"
mv "$MANIFIESTO.tmp" "$MANIFIESTO"

if [ ! -f "$WRANGLER" ]; then
  echo "No se encuentra $WRANGLER: no se ha podido ajustar MINI_COUNT. $MANIFIESTO ya quedó con $TOTAL obras; revisa $WRANGLER a mano." >&2
  exit 1
fi

sed -E -i.bak "s/^(MINI_COUNT[[:space:]]*=[[:space:]]*\")[0-9]+(\")/\1${TOTAL}\2/" "$WRANGLER"
# El .bak se borra por el trap de arriba (cubre también el caso en que el
# propio sed falle a medias).

LEIDO="$(grep -E '^MINI_COUNT' "$WRANGLER" | grep -oE '"[0-9]+"' | tr -d '"' || true)"
if [ "$LEIDO" != "$TOTAL" ]; then
  echo "MINI_COUNT en $WRANGLER no quedó en $TOTAL (dice '${LEIDO:-nada}'). $WRANGLER puede haber quedado a medias: revísalo a mano antes de desplegar." >&2
  exit 1
fi

echo "" >&2
echo "Detectadas $TOTAL obras. MINI_COUNT ajustado a $TOTAL en $WRANGLER." >&2
echo "Manifiesto actualizado: $MANIFIESTO" >&2
du -sh "$DESTINO" 2>/dev/null >&2 || true
