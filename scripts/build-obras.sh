#!/usr/bin/env bash
# Procesa las fotos del concurso y regenera concurso/obras.json.
#
#   1. Deja las fotos en  fotos-originales/  con el nombre del código: 01.jpg, 02.jpg…
#   2. Ejecuta:  ./scripts/build-obras.sh
#
# Requiere ImageMagick:  sudo apt install imagemagick webp
set -euo pipefail

RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
ORIGEN="$RAIZ/fotos-originales"
DESTINO="$RAIZ/concurso/obras"
MANIFIESTO="$RAIZ/concurso/obras.json"
TOTAL=22

if ! command -v magick >/dev/null && ! command -v convert >/dev/null; then
  echo "Falta ImageMagick. Instálalo con: sudo apt install imagemagick webp" >&2
  exit 1
fi
MAGICK="$(command -v magick || command -v convert)"

mkdir -p "$DESTINO"
: > "$MANIFIESTO.tmp"
echo "[" >> "$MANIFIESTO.tmp"

for i in $(seq -w 1 "$TOTAL"); do
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

  if [ "$i" != "$(printf '%02d' "$TOTAL")" ]; then echo "," >> "$MANIFIESTO.tmp"; else echo "" >> "$MANIFIESTO.tmp"; fi
done

echo "]" >> "$MANIFIESTO.tmp"
mv "$MANIFIESTO.tmp" "$MANIFIESTO"

echo "" >&2
echo "Manifiesto actualizado: $MANIFIESTO" >&2
du -sh "$DESTINO" 2>/dev/null >&2 || true
