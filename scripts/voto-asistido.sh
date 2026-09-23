#!/usr/bin/env bash
# Registra a mano un voto que no pudo emitirse por la web (§10 del spec del
# voto verificado por correo).
#
#   ./scripts/voto-asistido.sh --correo fulano@ejemplo.com --obra 07 \
#       --nota "no le llegaba el código, avisó por WhatsApp el 12/10 — Oskar"
#
# Los tres argumentos son obligatorios. La nota no es burocracia: el voto sale
# listado con ella en /admin/results, y es lo único que distingue "ayudamos a
# una persona" de "metimos un voto".
#
# Por qué un script y no SQL escrito al vuelo: un INSERT a mano se olvida de
# email_norm, y sin email_norm el índice único no protege nada — esa persona
# podría votar otra vez por la web y serían dos votos. Aquí la normalización
# la hace el MISMO módulo que usa el Worker.
set -euo pipefail

RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
CORREO=""
OBRA=""
NOTA=""
ENTORNO="produccion"
SIMULAR=""

uso() {
  cat >&2 <<'AYUDA'
Uso:
  voto-asistido.sh --correo <dirección> --obra <NN> --nota "<motivo>"
                   [--entorno produccion|test|correo] [--simular]

  --correo    dirección de quien vota
  --obra      código de obra de dos dígitos, 01..MINI_COUNT
  --nota      quién lo registra y por qué. Sale en el panel.
  --entorno   base sobre la que se escribe. Por defecto, producción.
  --simular   imprime el SQL y no ejecuta nada.
AYUDA
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --correo)  CORREO="${2:-}"; shift 2 ;;
    --obra)    OBRA="${2:-}"; shift 2 ;;
    --nota)    NOTA="${2:-}"; shift 2 ;;
    --entorno) ENTORNO="${2:-}"; shift 2 ;;
    --simular) SIMULAR=1; shift ;;
    -h|--help) uso ;;
    *) echo "Argumento desconocido: $1" >&2; uso ;;
  esac
done

[ -n "$CORREO" ] || { echo "Falta --correo" >&2; uso; }
[ -n "$OBRA" ]   || { echo "Falta --obra" >&2; uso; }
[ -n "$NOTA" ]   || { echo "Falta --nota. No es opcional: es lo que hace auditable este voto." >&2; uso; }

case "$OBRA" in
  [0-9][0-9]) : ;;
  *) echo "La obra debe ser un código de dos dígitos, por ejemplo 07." >&2; exit 1 ;;
esac

case "$ENTORNO" in
  produccion) BASE="laorden-votos";        ENV_FLAG="" ;;
  test)       BASE="laorden-votos-test";   ENV_FLAG="--env test" ;;
  correo)     BASE="laorden-votos-correo"; ENV_FLAG="--env correo" ;;
  *) echo "Entorno desconocido: $ENTORNO (produccion|test|correo)" >&2; exit 1 ;;
esac

# La normalización la hace el módulo del Worker, no una copia. Dos copias
# derivarían, y una copia derivada deja este voto conviviendo con el voto web
# de la misma persona.
NORM="$(CORREO="$CORREO" node --input-type=module -e "
  import { normalizarCorreo, correoValido } from '$RAIZ/worker/src/lib/correo-norm.js';
  const c = process.env.CORREO;
  if (!correoValido(c)) { process.stderr.write('dirección no válida\n'); process.exit(2); }
  process.stdout.write(normalizarCorreo(c));
")"

# Escapar comillas simples: es lo único que separa una nota con un apóstrofo de
# un SQL roto.
esc() { printf '%s' "$1" | sed "s/'/''/g"; }

CORREO_SQL="$(esc "$CORREO")"
NORM_SQL="$(esc "$NORM")"
NOTA_SQL="$(esc "$NOTA")"
AHORA="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
# voter_id aleatorio y propio: idx_votes_voter es único sobre los votos
# válidos, así que un voter_id fijo (o vacío) haría que el primer voto
# asistido bloqueara a todos los siguientes. Misma lección que la huella vacía.
VOTER_ID="asistido-$(openssl rand -hex 8)"

SQL_COMPROBAR="SELECT COUNT(*) AS n FROM votes WHERE status = 'valid' AND email_norm = '$NORM_SQL'"
SQL_INSERTAR="INSERT INTO votes (mini_code, voter_id, ip_hash, user_agent, country, asn, asn_name, created_at, status, email, email_norm, origen, nota) VALUES ('$OBRA', '$VOTER_ID', '', '', '', NULL, '', '$AHORA', 'valid', '$CORREO_SQL', '$NORM_SQL', 'asistido', '$NOTA_SQL')"

if [ -n "$SIMULAR" ]; then
  echo "Base:   $BASE ($ENTORNO)"
  echo "Normal: $NORM"
  echo
  echo "$SQL_COMPROBAR"
  echo
  echo "$SQL_INSERTAR"
  exit 0
fi

cd "$RAIZ/worker"

if ! npx wrangler whoami >/dev/null 2>&1; then
  echo "wrangler no está autenticado. Lanza:  cd worker && npx wrangler login" >&2
  exit 1
fi

# shellcheck disable=SC2086
YA="$(npx wrangler d1 execute "$BASE" $ENV_FLAG --remote --json \
        --command "$SQL_COMPROBAR" | node -e "
  let e=''; process.stdin.on('data',d=>e+=d).on('end',()=>{
    const r = JSON.parse(e);
    const filas = (r[0] && r[0].results) || [];
    process.stdout.write(String(filas.length ? filas[0].n : 0));
  });")"

if [ "$YA" != "0" ]; then
  cat >&2 <<AVISO

  Esa dirección ya tiene un voto válido ($NORM).

  Si hay que sustituirlo, primero se anula el anterior, con su motivo:

    npx wrangler d1 execute $BASE $ENV_FLAG --remote --command \\
      "UPDATE votes SET status='annulled', annul_reason='<motivo>' WHERE id=<id>"

  Anular libera la dirección, porque el índice único es parcial sobre los
  votos válidos.

AVISO
  exit 1
fi

# shellcheck disable=SC2086
npx wrangler d1 execute "$BASE" $ENV_FLAG --remote --command "$SQL_INSERTAR"

cat >&2 <<INFO

  Voto asistido registrado en $BASE.

    obra    #$OBRA
    correo  $CORREO  (normalizado: $NORM)
    nota    $NOTA

  Sale listado en /admin/results, en la sección "Votos asistidos", y cuenta
  en el recuento.

INFO
