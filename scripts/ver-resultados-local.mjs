// Dibuja /admin/results con datos de ejemplo, usando las consultas reales.
// Sin Worker y sin Access: solo la función que genera el HTML.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { page, TALLY, RISK } from '../worker/src/routes/admin.js';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const db = new DatabaseSync(':memory:');
db.exec(readFileSync(join(raiz, 'worker/migrations/0001_create_votes.sql'), 'utf8'));

const meter = db.prepare(
  `INSERT INTO votes (mini_code, voter_id, fingerprint, ip_hash, user_agent,
                      country, asn, asn_name, created_at, status)
   VALUES (?, ?, ?, ?, '', 'ES', 12430, ?, ?, 'valid')`
);

let n = 0;
function votar(obra, hash, red) {
  n += 1;
  const cuando = new Date(Date.UTC(2026, 9, 12, 10, n % 60, 0)).toISOString();
  meter.run(obra, `votante-${n}`, `huella-${n}`, hash, red, cuando);
}

// Reparto normal: la mayoría de la gente vota una vez desde su casa.
const reparto = { '03': 14, '07': 11, '12': 9, '01': 6, '19': 5, '22': 4, '08': 3, '15': 2 };
for (const [obra, cuantos] of Object.entries(reparto)) {
  for (let i = 0; i < cuantos; i += 1) votar(obra, `casa-${n}`, 'Euskaltel');
}

// Tres orígenes que deben salir marcados, uno por bandera.
for (const obra of ['01', '02', '03', '04', '05', '06']) votar(obra, 'hash-volumen', 'Movistar');
for (const obra of ['11', '14']) votar(obra, 'hash-datacenter', 'DigitalOcean Cloud Hosting');
for (let i = 0; i < 5; i += 1) votar('07', 'hash-concentrado', 'Vodafone');

const tally = db.prepare(TALLY).all();
const risk = db.prepare(RISK).all();
const totals = db.prepare("SELECT COUNT(*) AS n FROM votes WHERE status = 'valid'").get().n;

process.stdout.write(page(totals, tally, risk, 'ejemplo@laorden.org'));
