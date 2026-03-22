/**
 * AERIVUE ADMIN — Express.js Server
 * 
 * Features:
 *  - Full question CRUD (create, read, update, delete)
 *  - Bulk operations
 *  - Diagram/visual suggestion generation via Groq
 *  - Auth via simple admin token
 *  - Serves the admin panel HTML
 * 
 * Install:  npm install
 * Run:      node server.js
 * Admin:    http://localhost:3001
 */

const express    = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const Groq       = require('groq-sdk');
const cors       = require('cors');
const path       = require('path');
require('dotenv').config();

const app  = express();
const PORT = process.env.ADMIN_PORT || 3001;

// ── CONFIG ──────────────────────────────────────────
const MONGO_URI    = process.env.MONGO_URI    || 'mongodb://localhost:27017';
const DB_NAME      = process.env.DB_NAME      || 'synapse';
const COLLECTION   = process.env.COLLECTION   || 'questions';
const GROQ_KEY     = process.env.GROQ_API_KEY || '';
const ADMIN_TOKEN  = process.env.ADMIN_TOKEN  || 'aerivue-admin-2024'; // change this!

// ── MIDDLEWARE ──────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── DB ──────────────────────────────────────────────
let db, col;
(async () => {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db  = client.db(DB_NAME);
  col = db.collection(COLLECTION);
  console.log(`✓ MongoDB connected → ${DB_NAME}.${COLLECTION}`);
})();

// ── GROQ ────────────────────────────────────────────
const groq = GROQ_KEY ? new Groq({ apiKey: GROQ_KEY }) : null;

// ── AUTH MIDDLEWARE ─────────────────────────────────
function auth(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ═══════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════

// ── STATS ───────────────────────────────────────────
app.get('/api/stats', auth, async (req, res) => {
  try {
    const total    = await col.countDocuments({});
    const bySubject = await col.aggregate([
      { $group: { _id: '$subject', count: { $sum: 1 }, topics: { $addToSet: '$topic' } } },
      { $sort: { count: -1 } }
    ]).toArray();
    const byExam = await col.aggregate([
      { $group: { _id: '$exam', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]).toArray();
    const noAnswer = await col.countDocuments({ $or: [{ answer: null }, { answer: '' }] });
    const noOptions = await col.countDocuments({ $or: [{ options: null }, { options: { $size: 0 } }] });

    res.json({ total, bySubject, byExam, issues: { noAnswer, noOptions } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── LIST QUESTIONS ──────────────────────────────────
app.get('/api/questions', auth, async (req, res) => {
  try {
    const {
      subject, topic, exam, year, search,
      page = 1, limit = 50,
      sort = 'createdAt', order = 'desc',
      issues  // 'noAnswer' | 'noOptions' | 'short'
    } = req.query;

    const query = {};
    if (subject) query.subject = subject;
    if (topic)   query.topic   = topic;
    if (exam)    query.exam    = exam;
    if (year)    query.year    = year;
    if (search)  query.question = { $regex: search, $options: 'i' };

    // Issue filters
    if (issues === 'noAnswer')  query.$or = [{ answer: null }, { answer: '' }];
    if (issues === 'noOptions') query.$or = [{ options: null }, { options: { $size: 0 } }];
    if (issues === 'short')     query.question = { $regex: '^.{0,20}$' };

    const skip  = (parseInt(page) - 1) * parseInt(limit);
    const total = await col.countDocuments(query);
    const docs  = await col
      .find(query, { projection: { _id: 1, id: 1, question: 1, options: 1, answer: 1, exam: 1, year: 1, subject: 1, topic: 1, uniqueId: 1 } })
      .sort({ [sort]: order === 'asc' ? 1 : -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .toArray();

    res.json({ total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / limit), questions: docs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET ONE QUESTION ────────────────────────────────
app.get('/api/questions/:id', auth, async (req, res) => {
  try {
    const q = await col.findOne({ _id: new ObjectId(req.params.id) });
    if (!q) return res.status(404).json({ error: 'Not found' });
    res.json(q);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── UPDATE QUESTION ─────────────────────────────────
app.put('/api/questions/:id', auth, async (req, res) => {
  try {
    const { _id, ...updates } = req.body;
    updates.updatedAt = new Date().toISOString();

    // Regenerate uniqueId if question/subject/topic changed
    if (updates.question || updates.subject || updates.topic) {
      const existing = await col.findOne({ _id: new ObjectId(req.params.id) });
      const merged   = { ...existing, ...updates };
      const snip     = String(merged.question || '').replace(/\W/g, '').slice(0, 28);
      updates.uniqueId = `${merged.subject}|${merged.topic}|${merged.id || 'x'}|${snip}`;
    }

    const result = await col.updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: updates }
    );
    res.json({ success: true, modified: result.modifiedCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CREATE QUESTION ─────────────────────────────────
app.post('/api/questions', auth, async (req, res) => {
  try {
    const q    = req.body;
    const snip = String(q.question || '').replace(/\W/g, '').slice(0, 28);
    q.uniqueId  = `${q.subject}|${q.topic}|${q.id || Date.now()}|${snip}`;
    q.createdAt = new Date().toISOString();

    const result = await col.insertOne(q);
    res.json({ success: true, _id: result.insertedId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE QUESTION ─────────────────────────────────
app.delete('/api/questions/:id', auth, async (req, res) => {
  try {
    const result = await col.deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ success: true, deleted: result.deletedCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── BULK DELETE ─────────────────────────────────────
app.post('/api/questions/bulk-delete', auth, async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids?.length) return res.status(400).json({ error: 'No IDs provided' });
    const result = await col.deleteMany({ _id: { $in: ids.map(id => new ObjectId(id)) } });
    res.json({ success: true, deleted: result.deletedCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── BULK UPDATE (subject/topic/exam) ────────────────
app.post('/api/questions/bulk-update', auth, async (req, res) => {
  try {
    const { ids, updates } = req.body;
    if (!ids?.length) return res.status(400).json({ error: 'No IDs provided' });
    const allowed = ['subject', 'topic', 'exam', 'year'];
    const safe    = {};
    allowed.forEach(k => { if (updates[k] !== undefined) safe[k] = updates[k]; });
    safe.updatedAt = new Date().toISOString();

    const result = await col.updateMany(
      { _id: { $in: ids.map(id => new ObjectId(id)) } },
      { $set: safe }
    );
    res.json({ success: true, modified: result.modifiedCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SUBJECTS / TOPICS LIST ──────────────────────────
app.get('/api/meta', auth, async (req, res) => {
  try {
    const subjects = await col.distinct('subject');
    const topics   = await col.distinct('topic');
    const exams    = await col.distinct('exam');
    const years    = await col.distinct('year');
    res.json({ subjects, topics, exams, years });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── AI: IMPROVE QUESTION ────────────────────────────
app.post('/api/ai/improve', auth, async (req, res) => {
  if (!groq) return res.status(503).json({ error: 'Groq not configured' });

  const { question, options, answer, explanation } = req.body;

  try {
    const msg = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 1500,
      temperature: 0.3,
      messages: [{
        role: 'system',
        content: `You are an expert editor for Indian competitive exam MCQs (UPSC, NDA, CDS, CAPF).
Improve the given question. Return ONLY valid JSON with these exact keys:
{
  "question": "improved question text",
  "options": ["opt a", "opt b", "opt c", "opt d"],
  "answer": "a",
  "explanation": "brief 2-sentence explanation",
  "issues_found": ["list of issues you fixed"]
}`
      }, {
        role: 'user',
        content: `Question: ${question}\nOptions: ${JSON.stringify(options)}\nAnswer: ${answer}\nExplanation: ${explanation || ''}`
      }],
      response_format: { type: 'json_object' }
    });

    const result = JSON.parse(msg.choices[0].message.content);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── AI: GENERATE VISUAL/DIAGRAM SUGGESTION ──────────
app.post('/api/ai/diagram', auth, async (req, res) => {
  if (!groq) return res.status(503).json({ error: 'Groq not configured' });

  const { question, options, answer, explanation } = req.body;

  try {
    const msg = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 2000,
      temperature: 0.4,
      messages: [{
        role: 'system',
        content: `You are an expert at creating visual study aids for Indian competitive exams.
Given an MCQ question, suggest a comparison table or diagram that would help students understand and remember the concept.

Return ONLY valid JSON with this structure:
{
  "type": "comparison_table" | "timeline" | "hierarchy" | "process_flow" | "fact_box",
  "title": "short descriptive title",
  "description": "why this visual helps",
  "data": {
    // For comparison_table:
    "headers": ["Column 1", "Column 2"],
    "rows": [["Cell 1", "Cell 2"], ...],
    
    // For timeline:
    "events": [{"year": "1947", "event": "Independence"}, ...],
    
    // For hierarchy:
    "root": "Top Level",
    "children": [{"name": "Child 1", "children": [...]}, ...],
    
    // For process_flow:
    "steps": ["Step 1", "Step 2", ...],
    
    // For fact_box:
    "facts": [{"label": "Capital", "value": "New Delhi"}, ...]
  },
  "key_insight": "The most important thing to remember"
}`
      }, {
        role: 'user',
        content: `Create a visual aid for this question:\n\nQ: ${question}\nOptions: ${JSON.stringify(options)}\nCorrect Answer: ${answer}\nExplanation: ${explanation || ''}`
      }],
      response_format: { type: 'json_object' }
    });

    const result = JSON.parse(msg.choices[0].message.content);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── AI: FIX BROKEN OPTIONS ──────────────────────────
app.post('/api/ai/fix-options', auth, async (req, res) => {
  if (!groq) return res.status(503).json({ error: 'Groq not configured' });

  const { question, options } = req.body;

  try {
    const msg = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 800,
      temperature: 0.1,
      messages: [{
        role: 'system',
        content: `Fix broken/garbled MCQ options. Return ONLY JSON: {"options": ["clean opt a", "clean opt b", "clean opt c", "clean opt d"]}`
      }, {
        role: 'user',
        content: `Question: ${question}\nBroken options: ${JSON.stringify(options)}\nFix these options to be clean, short answer choices (2-20 words each).`
      }],
      response_format: { type: 'json_object' }
    });

    const result = JSON.parse(msg.choices[0].message.content);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SERVE ADMIN PANEL ───────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── START ────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('═'.repeat(44));
  console.log('  AERIVUE ADMIN SERVER');
  console.log('═'.repeat(44));
  console.log(`  URL:   http://localhost:${PORT}`);
  console.log(`  Token: ${ADMIN_TOKEN}`);
  console.log(`  Groq:  ${groq ? '✓ ready' : '✗ not configured'}`);
  console.log('═'.repeat(44));
});