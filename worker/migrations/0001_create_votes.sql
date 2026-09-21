CREATE TABLE votes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  mini_code    TEXT    NOT NULL,
  voter_id     TEXT    NOT NULL,
  fingerprint  TEXT    NOT NULL,
  ip_hash      TEXT    NOT NULL,
  user_agent   TEXT    NOT NULL DEFAULT '',
  country      TEXT    NOT NULL DEFAULT '',
  asn          INTEGER,
  asn_name     TEXT    NOT NULL DEFAULT '',
  created_at   TEXT    NOT NULL,
  status       TEXT    NOT NULL DEFAULT 'valid'
               CHECK (status IN ('valid','annulled')),
  annul_reason TEXT
);

CREATE UNIQUE INDEX idx_votes_voter ON votes(voter_id)    WHERE status = 'valid';
CREATE UNIQUE INDEX idx_votes_fp    ON votes(fingerprint) WHERE status = 'valid';
CREATE INDEX        idx_votes_ip    ON votes(ip_hash);
CREATE INDEX        idx_votes_time  ON votes(created_at);
