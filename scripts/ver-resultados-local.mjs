// Dibuja /admin/results con datos de ejemplo, usando las consultas reales.
// Sin Worker y sin Access: solo la función que genera el HTML.
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { page, TALLY, RISK, ASISTIDOS, buildObrasIndex } from '../worker/src/routes/admin.js';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');

// Igual que en el Worker: se lee concurso/obras.json para saber qué obras
// tienen foto, pero aquí con rutas file:// absolutas al repo (derivadas de
// import.meta.url), no /concurso/..., porque este HTML se abre desde /tmp
// con file:// y no hay servidor delante que resuelva esa ruta absoluta.
// Si el manifiesto no está o no se puede leer, se sigue sin miniaturas —
// mismo comportamiento que un fetch fallido en el Worker.
let obras = new Map();
try {
  const manifiestoUrl = pathToFileURL(join(raiz, 'concurso/obras.json'));
  const lista = JSON.parse(readFileSync(manifiestoUrl, 'utf8'));
  obras = buildObrasIndex(lista, manifiestoUrl);
} catch {
  // sin manifiesto legible: la página sale igual, sin miniaturas.
}
const db = new DatabaseSync(':memory:');
const dirMigraciones = join(raiz, 'worker/migrations');
for (const fichero of readdirSync(dirMigraciones).sort()) {
  if (fichero.endsWith('.sql')) db.exec(readFileSync(join(dirMigraciones, fichero), 'utf8'));
}

const meter = db.prepare(
  `INSERT INTO votes (mini_code, voter_id, ip_hash, user_agent,
                      country, asn, asn_name, created_at, status, email, email_norm)
   VALUES (?, ?, ?, '', 'ES', 12430, ?, ?, 'valid', ?, ?)`
);

let n = 0;
function votar(obra, hash, red) {
  n += 1;
  const cuando = new Date(Date.UTC(2026, 9, 12, 10, n % 60, 0)).toISOString();
  const correo = `votante${n}@ejemplo.com`;
  meter.run(obra, `votante-${n}`, hash, red, cuando, correo, correo);
}

// Reparto normal: la mayoría de la gente vota una vez desde su casa.
const reparto = { '03': 14, '07': 11, '02': 9, '01': 6, '09': 5, '10': 4, '08': 3, '05': 2 };
for (const [obra, cuantos] of Object.entries(reparto)) {
  for (let i = 0; i < cuantos; i += 1) votar(obra, `casa-${n}`, 'Euskaltel');
}

// Tres orígenes que deben salir marcados, uno por bandera.
for (const obra of ['01', '02', '03', '04', '05', '06']) votar(obra, 'hash-volumen', 'Movistar');
for (const obra of ['04', '06']) votar(obra, 'hash-datacenter', 'DigitalOcean Cloud Hosting');
for (let i = 0; i < 5; i += 1) votar('07', 'hash-concentrado', 'Vodafone');

// Un voto asistido, para que se vea la sección del §10 sin tener que
// inventársela mirando el código.
db.prepare(
  `INSERT INTO votes (mini_code, voter_id, ip_hash, user_agent, country, asn,
                      asn_name, created_at, status, email, email_norm, origen, nota)
   VALUES ('03', 'asistido-ejemplo', '', '', 'ES', NULL, '',
           '2026-10-12T18:30:00.000Z', 'valid',
           'ejemplo@ejemplo.com', 'ejemplo@ejemplo.com', 'asistido',
           'no le llegaba el código, avisó por WhatsApp el 12/10 — ejemplo')`
).run();

const tally = db.prepare(TALLY).all();
const risk = db.prepare(RISK).all();
const totals = db.prepare("SELECT COUNT(*) AS n FROM votes WHERE status = 'valid'").get().n;

const asistidos = db.prepare(ASISTIDOS).all();
process.stdout.write(page(totals, tally, risk, 'ejemplo@laorden.org', obras,
                          { enviados: 37, techo: 400 }, asistidos));
