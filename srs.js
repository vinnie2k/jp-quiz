const db = require('./db');

function getSession(user) {
  let row = db.prepare('SELECT * FROM sessions WHERE user = ?').get(user);
  if (!row) {
    db.prepare('INSERT OR IGNORE INTO sessions (user) VALUES (?)').run(user);
    row = db.prepare('SELECT * FROM sessions WHERE user = ?').get(user);
  }
  return row;
}

function ensureSRS(user) {
  db.prepare(`
    INSERT OR IGNORE INTO srs (user, question_id)
    SELECT ?, id FROM questions
  `).run(user);
}

function buildFilters(filters = {}) {
  const { tags = [], niveaux = [] } = filters;
  const clauses = [];
  const params = [];

  if (tags.length > 0) {
    const tagClauses = tags.map(() => "q.tags LIKE ?").join(' OR ');
    clauses.push(`(${tagClauses})`);
    tags.forEach(t => params.push(`%"${t}"%`));
  }

  if (niveaux.length > 0) {
    clauses.push(`q.niveau IN (${niveaux.map(() => '?').join(',')})`);
    niveaux.forEach(n => params.push(n));
  }

  return {
    sql: clauses.length ? ' AND ' + clauses.join(' AND ') : '',
    params
  };
}

function getNextQuestion(user, filters = {}) {
  ensureSRS(user);
  const session = getSession(user);
  const compteur = session.compteur;
  const f = buildFilters(filters);

  let row = db.prepare(`
    SELECT q.id, q.niveau, q.tags, q.question, s.etat
    FROM questions q JOIN srs s ON q.id = s.question_id
    WHERE s.user = ? AND s.etat = 'a_retravailler' AND s.prochain_affichage <= ?
    ${f.sql}
    ORDER BY s.prochain_affichage ASC LIMIT 1
  `).get(user, compteur, ...f.params);
  if (row) return row;

  row = db.prepare(`
    SELECT q.id, q.niveau, q.tags, q.question, s.etat
    FROM questions q JOIN srs s ON q.id = s.question_id
    WHERE s.user = ? AND s.etat IN ('a_reconfirmer_1','a_reconfirmer_2') AND s.prochain_affichage <= ?
    ${f.sql}
    ORDER BY s.prochain_affichage ASC LIMIT 1
  `).get(user, compteur, ...f.params);
  if (row) return row;

  // Avec filtres actifs : pas de logique de déblocage par niveau (on sert tous les niveaux filtrés)
  const hasFilter = f.sql !== '';

  if (hasFilter) {
    row = db.prepare(`
      SELECT q.id, q.niveau, q.tags, q.question, s.etat
      FROM questions q JOIN srs s ON q.id = s.question_id
      WHERE s.user = ? AND s.etat = 'non_vue'
      ${f.sql}
      ORDER BY q.niveau ASC, RANDOM() LIMIT 1
    `).get(user, ...f.params);
    return row || null;
  }

  // Sans filtre : logique de déblocage progressif par niveau
  const l2Vues = db.prepare(`
    SELECT COUNT(*) AS c FROM srs s JOIN questions q ON s.question_id = q.id
    WHERE s.user = ? AND q.niveau = 2 AND s.etat != 'non_vue'
  `).get(user).c;
  const l3Vues = db.prepare(`
    SELECT COUNT(*) AS c FROM srs s JOIN questions q ON s.question_id = q.id
    WHERE s.user = ? AND q.niveau = 3 AND s.etat != 'non_vue'
  `).get(user).c;

  let niveauMax = 1;
  if (session.l2_debloquees > l2Vues) niveauMax = 2;
  if (session.l3_debloquees > l3Vues) niveauMax = 3;

  row = db.prepare(`
    SELECT q.id, q.niveau, q.tags, q.question, s.etat
    FROM questions q JOIN srs s ON q.id = s.question_id
    WHERE s.user = ? AND s.etat = 'non_vue' AND q.niveau <= ?
    ORDER BY q.niveau ASC, RANDOM() LIMIT 1
  `).get(user, niveauMax);

  return row || null;
}

function recordAnswer(user, questionId, correct) {
  const session = getSession(user);
  const srsRow = db.prepare(
    'SELECT * FROM srs WHERE user = ? AND question_id = ?'
  ).get(user, questionId);
  const question = db.prepare('SELECT niveau FROM questions WHERE id = ?').get(questionId);

  let newEtat, newProchain, newBonnes, newIntervalle;

  if (correct) {
    newBonnes = srsRow.bonnes_reponses + 1;
    newIntervalle = srsRow.intervalle_erreur;
    if (newBonnes >= 3) {
      newEtat = 'maitrisee'; newProchain = 9999999;
    } else if (newBonnes === 2) {
      newEtat = 'a_reconfirmer_2'; newProchain = session.compteur + 12;
    } else {
      newEtat = 'a_reconfirmer_1'; newProchain = session.compteur + 12;
    }
    if (srsRow.bonnes_reponses === 0) {
      if (question.niveau === 1)
        db.prepare('UPDATE sessions SET l2_debloquees = l2_debloquees + 1 WHERE user = ?').run(user);
      else if (question.niveau === 2)
        db.prepare('UPDATE sessions SET l3_debloquees = l3_debloquees + 1 WHERE user = ?').run(user);
    }
  } else {
    newBonnes = srsRow.bonnes_reponses;
    newEtat = 'a_retravailler';
    newProchain = session.compteur + srsRow.intervalle_erreur;
    newIntervalle = Math.max(srsRow.intervalle_erreur - 2, 2);
  }

  db.prepare(`
    UPDATE srs SET etat=?, bonnes_reponses=?, intervalle_erreur=?, prochain_affichage=?
    WHERE user=? AND question_id=?
  `).run(newEtat, newBonnes, newIntervalle, newProchain, user, questionId);

  const newCompteur = session.compteur + 1;
  db.prepare('UPDATE sessions SET compteur=? WHERE user=?').run(newCompteur, user);

  return {
    etat: newEtat,
    compteur: newCompteur,
    showBilan: newCompteur % 10 === 0,
    stats: getStats(user, newCompteur)
  };
}

function getStats(user, compteur, filters = {}) {
  const f = buildFilters(filters);
  const rows = db.prepare(`
    SELECT s.etat, COUNT(*) AS c
    FROM srs s JOIN questions q ON s.question_id = q.id
    WHERE s.user = ? ${f.sql}
    GROUP BY s.etat
  `).all(user, ...f.params);

  const result = { maitrisee: 0, a_reconfirmer: 0, a_retravailler: 0, non_vue: 0, total: 0 };
  for (const row of rows) {
    result.total += row.c;
    if (row.etat === 'maitrisee') result.maitrisee += row.c;
    else if (row.etat === 'a_reconfirmer_1' || row.etat === 'a_reconfirmer_2') result.a_reconfirmer += row.c;
    else if (row.etat === 'a_retravailler') result.a_retravailler += row.c;
    else result.non_vue += row.c;
  }
  const session = getSession(user);
  result.compteur = compteur !== undefined ? compteur : session.compteur;
  return result;
}

function resetSession(user) {
  db.prepare('UPDATE sessions SET compteur=0, l2_debloquees=0, l3_debloquees=0 WHERE user=?').run(user);
  db.prepare(`UPDATE srs SET etat='non_vue', bonnes_reponses=0, intervalle_erreur=6, prochain_affichage=0 WHERE user=?`).run(user);
}

module.exports = { getNextQuestion, recordAnswer, getStats, resetSession };
