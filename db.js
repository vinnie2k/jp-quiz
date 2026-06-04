const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'quiz.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS questions (
    id                TEXT PRIMARY KEY,
    niveau            INTEGER NOT NULL,
    tags              TEXT NOT NULL,
    question          TEXT NOT NULL,
    reponse_reference TEXT NOT NULL,
    explication       TEXT NOT NULL,
    source_page       INTEGER
  );
`);

// Migration : ajouter la colonne user si elle n'existe pas encore
const srsCols = db.prepare('PRAGMA table_info(srs)').all().map(r => r.name);
if (srsCols.length === 0) {
  // Table n'existe pas encore — créer proprement
  db.exec(`
    CREATE TABLE srs (
      user              TEXT NOT NULL,
      question_id       TEXT NOT NULL,
      etat              TEXT NOT NULL DEFAULT 'non_vue',
      bonnes_reponses   INTEGER NOT NULL DEFAULT 0,
      intervalle_erreur INTEGER NOT NULL DEFAULT 6,
      prochain_affichage INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user, question_id),
      FOREIGN KEY (question_id) REFERENCES questions(id)
    );
  `);
} else if (!srsCols.includes('user')) {
  // Ancienne table sans user — migration
  db.exec(`
    ALTER TABLE srs RENAME TO srs_old;
    CREATE TABLE srs (
      user              TEXT NOT NULL,
      question_id       TEXT NOT NULL,
      etat              TEXT NOT NULL DEFAULT 'non_vue',
      bonnes_reponses   INTEGER NOT NULL DEFAULT 0,
      intervalle_erreur INTEGER NOT NULL DEFAULT 6,
      prochain_affichage INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user, question_id),
      FOREIGN KEY (question_id) REFERENCES questions(id)
    );
    DROP TABLE srs_old;
  `);
  console.log('[db] Migration srs → schéma multi-user effectuée');
}

// Migration : corriger intervalle_erreur=3 (ancien défaut) → 6
const updated = db.prepare(
  "UPDATE srs SET intervalle_erreur=6 WHERE intervalle_erreur=3"
).run();
if (updated.changes > 0)
  console.log(`[db] Migration intervalle_erreur : ${updated.changes} lignes mises à jour (3→6)`);

const sessionCols = db.prepare('PRAGMA table_info(sessions)').all().map(r => r.name);
if (sessionCols.length === 0) {
  db.exec(`
    CREATE TABLE sessions (
      user          TEXT PRIMARY KEY,
      compteur      INTEGER NOT NULL DEFAULT 0,
      l2_debloquees INTEGER NOT NULL DEFAULT 0,
      l3_debloquees INTEGER NOT NULL DEFAULT 0
    );
  `);
} else if (!sessionCols.includes('user')) {
  db.exec(`
    DROP TABLE sessions;
    CREATE TABLE sessions (
      user          TEXT PRIMARY KEY,
      compteur      INTEGER NOT NULL DEFAULT 0,
      l2_debloquees INTEGER NOT NULL DEFAULT 0,
      l3_debloquees INTEGER NOT NULL DEFAULT 0
    );
  `);
  console.log('[db] Migration sessions → schéma multi-user effectuée');
}

module.exports = db;
