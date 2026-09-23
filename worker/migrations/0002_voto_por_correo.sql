-- Voto verificado por correo (spec 2026-09-22).
--
-- `email` es lo que escribió la persona: es lo que ve el panel, y es a donde
-- se mandó el código. `email_norm` es la forma canónica y es la que lleva el
-- índice único. Se guardan las dos a propósito: la primera es legible para un
-- humano que revisa el §10, la segunda es la que deduplica.
ALTER TABLE votes ADD COLUMN email      TEXT NOT NULL DEFAULT '';
ALTER TABLE votes ADD COLUMN email_norm TEXT NOT NULL DEFAULT '';
ALTER TABLE votes ADD COLUMN origen     TEXT NOT NULL DEFAULT 'web'
                             CHECK (origen IN ('web','asistido'));
ALTER TABLE votes ADD COLUMN nota       TEXT NOT NULL DEFAULT '';

-- La guarda `email_norm != ''` repite una lección ya aprendida en este
-- esquema con la huella vacía: si un valor vacío entrase en el índice único,
-- la primera fila sin correo bloquearía a todas las demás.
-- Parcial sobre status='valid': anular un voto libera esa dirección, igual
-- que ya pasa con voter_id.
CREATE UNIQUE INDEX idx_votes_email ON votes(email_norm)
  WHERE status = 'valid' AND email_norm != '';

-- El índice va primero: SQLite no deja soltar una columna referenciada por un
-- índice. (PLAN B: deja estas dos líneas comentadas salvo la primera.)
DROP INDEX idx_votes_fp;
ALTER TABLE votes DROP COLUMN fingerprint;

-- El código se guarda como HMAC, nunca en claro. Seis dígitos es un millón de
-- combinaciones: trivial de romper por fuerza bruta desde un volcado de la
-- base, SALVO que la clave del HMAC viva fuera de ella. Vive fuera: es
-- IP_SALT, un secreto del Worker.
-- Las filas usadas NO se borran: son la prueba del límite por dirección y el
-- rastro de quién pidió qué. Se vacían el 16 de noviembre (§11.3).
CREATE TABLE codigos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email_norm  TEXT    NOT NULL,
  codigo_hash TEXT    NOT NULL,
  expira_en   TEXT    NOT NULL,
  intentos    INTEGER NOT NULL DEFAULT 0,
  ip_hash     TEXT    NOT NULL,
  created_at  TEXT    NOT NULL,
  usado_en    TEXT
);

CREATE INDEX idx_codigos_email  ON codigos(email_norm);
CREATE INDEX idx_codigos_creado ON codigos(created_at);
