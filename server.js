const express = require('express');
const path = require('path');
const fs = require('fs');
const cookieParser = require('cookie-parser');
const db = require('./db');
const srs = require('./srs');

const app = express();
app.use(express.json());
app.use(cookieParser());

const BASE = (process.env.SUBPATH || '').replace(/\/$/, '');
const COOKIE = 'jp_user';
const COOKIE_DAYS = 30;

function getUser(req) {
  const raw = req.cookies[COOKIE] || '';
  return raw.trim().slice(0, 32).replace(/[^a-zA-Z0-9_\-\.]/g, '') || null;
}

function requireUser(req, res, next) {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'no_user' });
  req.user = user;
  next();
}

function parseFilters(query) {
  const tags = query.tags ? query.tags.split(',').filter(Boolean) : [];
  const niveaux = query.niveaux ? query.niveaux.split(',').map(Number).filter(Boolean) : [];
  return { tags, niveaux };
}

function serveApp(res) {
  const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  res.type('html').send(html.replace(/\{\{BASE\}\}/g, BASE));
}

app.get(BASE,        (req, res) => serveApp(res));
app.get(BASE + '/', (req, res) => serveApp(res));

app.post(BASE + '/api/login', (req, res) => {
  const pseudo = (req.body.pseudo || '').trim().slice(0, 32).replace(/[^a-zA-Z0-9_\-\.]/g, '');
  if (!pseudo) return res.status(400).json({ error: 'Pseudo invalide' });
  res.cookie(COOKIE, pseudo, {
    maxAge: COOKIE_DAYS * 86400 * 1000,
    httpOnly: true,
    sameSite: 'lax'
  });
  res.json({ success: true, user: pseudo });
});

app.post(BASE + '/api/logout', (req, res) => {
  res.clearCookie(COOKIE);
  res.json({ success: true });
});

app.get(BASE + '/api/me', (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'no_user' });
  res.json({ user });
});

app.get(BASE + '/api/tags', requireUser, (req, res) => {
  const rows = db.prepare('SELECT DISTINCT tags FROM questions').all();
  const tagSet = new Set();
  for (const row of rows) {
    try { JSON.parse(row.tags).forEach(t => tagSet.add(t)); } catch(e) {}
  }
  res.json({ tags: [...tagSet].sort() });
});

app.post(BASE + '/api/import', requireUser, (req, res) => {
  try {
    const jsonPath = process.env.QUESTIONS_PATH
      || path.join(__dirname, 'data', 'jp_questions.json');
    if (!fs.existsSync(jsonPath))
      return res.status(404).json({ error: `Fichier introuvable : ${jsonPath}` });
    const questions = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const insertQ = db.prepare(`
      INSERT OR REPLACE INTO questions
        (id, niveau, tags, question, reponse_reference, explication, source_page)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    db.transaction((qs) => {
      for (const q of qs)
        insertQ.run(q.id, q.niveau, JSON.stringify(q.tags),
          q.question, q.reponse_reference, q.explication, q.source_page ?? null);
    })(questions);
    res.json({ success: true, count: questions.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get(BASE + '/api/question', requireUser, (req, res) => {
  const filters = parseFilters(req.query);
  const q = srs.getNextQuestion(req.user, filters);
  if (!q) return res.json({ done: true });
  res.json(q);
});

app.get(BASE + '/api/question/:id/details', requireUser, (req, res) => {
  const q = db.prepare('SELECT * FROM questions WHERE id = ?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Question introuvable' });
  res.json(q);
});

app.post(BASE + '/api/answer', requireUser, (req, res) => {
  const { questionId, correct } = req.body;
  if (!questionId || typeof correct !== 'boolean')
    return res.status(400).json({ error: 'Paramètres invalides' });
  res.json(srs.recordAnswer(req.user, questionId, correct));
});

app.get(BASE + '/api/stats', requireUser, (req, res) => {
  const filters = parseFilters(req.query);
  res.json(srs.getStats(req.user, undefined, filters));
});

app.post(BASE + '/api/reset', requireUser, (req, res) => {
  srs.resetSession(req.user);
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`JP Quiz → http://localhost:${PORT}${BASE}/`);
  autoImport();
});

function autoImport() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM questions').get().c;
  if (count > 0) { console.log(`[import] ${count} questions déjà en base`); return; }
  const jsonPath = process.env.QUESTIONS_PATH || path.join(__dirname, 'data', 'jp_questions.json');
  if (!fs.existsSync(jsonPath)) { console.log('[import] JSON introuvable, import ignoré'); return; }
  try {
    const questions = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const ins = db.prepare(`INSERT OR REPLACE INTO questions
      (id,niveau,tags,question,reponse_reference,explication,source_page)
      VALUES (?,?,?,?,?,?,?)`);
    db.transaction(qs => {
      for (const q of qs)
        ins.run(q.id,q.niveau,JSON.stringify(q.tags),
          q.question,q.reponse_reference,q.explication,q.source_page??null);
    })(questions);
    console.log(`[import] ${questions.length} questions importées automatiquement`);
  } catch(err) { console.error('[import] Erreur:', err.message); }
}
