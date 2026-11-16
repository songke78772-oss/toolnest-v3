require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const { PDFDocument } = require('pdf-lib');
const { exec } = require('child_process');
const { promisify } = require('util');
const { Resend } = require('resend');
const execAsync = promisify(exec);

const app = express();
const resend = new Resend(process.env.RESEND_API_KEY);
const verificationCodes = new Map();

const db = new Database(path.join(__dirname, 'data', 'app.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    subscription_status TEXT DEFAULT 'inactive',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS tools (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    category TEXT DEFAULT 'Other',
    type TEXT DEFAULT 'online',
    url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS favorites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    tool_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, tool_id)
  );

  CREATE TABLE IF NOT EXISTS tool_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT,
    content TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

function requireLogin(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');
  next();
}

// Home
app.get('/', (req, res) => {
  const tools = db.prepare('SELECT * FROM tools ORDER BY id DESC').all();
  res.render('index', { loggedIn: !!req.session.userId, user: req.session.userId, tools, q: req.query.q || '' });
});

// Register with email verification
app.get('/register', (req, res) => res.render('register', { error: null }));

app.post('/api/send-code', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.json({ success: false, error: 'Email required' });
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  verificationCodes.set(email, { code, expires: Date.now() + 10 * 60 * 1000 });
  try {
    await resend.emails.send({
      from: 'ToolNest <noreply@protoolnest.com>',
      to: email,
      subject: 'Your ToolNest Verification Code',
      html: `<p>Your verification code is:</p><p style="font-size:28px;font-weight:bold;">${code}</p><p>Valid for 10 minutes.</p>`
    });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.json({ success: false, error: 'Failed to send email' });
  }
});

app.post('/register', (req, res) => {
  const { email, password, code } = req.body;
  const stored = verificationCodes.get(email);
  if (!stored || stored.code !== code || stored.expires < Date.now()) {
    return res.render('register', { error: 'Invalid or expired verification code' });
  }
  try {
    const hash = bcrypt.hashSync(password, 10);
    db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run(email, hash);
    verificationCodes.delete(email);
    res.redirect('/login');
  } catch (err) {
    res.render('register', { error: 'Email already exists' });
  }
});

// Login / Logout
app.get('/login', (req, res) => res.render('login', { error: null }));

app.post('/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.render('login', { error: 'Invalid email or password' });
  }
  req.session.userId = user.id;
  req.session.email = user.email;
  res.redirect('/');
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// Dashboard
app.get('/dashboard', requireLogin, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId) || { email: 'User' };
  const favorites = db.prepare(`
    SELECT t.* FROM tools t
    JOIN favorites f ON f.tool_id = t.id
    WHERE f.user_id = ?
  `).all(req.session.userId) || [];
  res.render('dashboard', { user, favorites });
});

// Dynamic tool page
app.get('/tool/:id', requireLogin, (req, res) => {
  const tool = db.prepare('SELECT * FROM tools WHERE id = ?').get(req.params.id);
  if (!tool) return res.status(404).send('Tool not found');
  res.render('tool', { tool });
});

// ===== Built-in tool pages =====
app.get('/compress', (req, res) => res.render('compress'));
app.get('/resize', (req, res) => res.render('resize'));
app.get('/crop', (req, res) => res.render('crop'));
app.get('/png-to-jpg', (req, res) => res.render('png-to-jpg'));
app.get('/jpg-to-png', (req, res) => res.render('jpg-to-png'));
app.get('/black-white', (req, res) => res.render('black-white'));
app.get('/flip', (req, res) => res.render('flip'));
app.get('/round', (req, res) => res.render('round'));
app.get('/add-border', (req, res) => res.render('add-border'));
app.get('/pixelate', (req, res) => res.render('pixelate'));
app.get('/add-text', (req, res) => res.render('add-text'));
app.get('/blur-bg', (req, res) => res.render('blur-bg'));
app.get('/remove-bg', (req, res) => res.render('remove-bg'));
app.get('/metadata', (req, res) => res.render('metadata'));
app.get('/combine', (req, res) => res.render('combine'));
app.get('/collage', (req, res) => res.render('collage'));
app.get('/chart', (req, res) => res.render('chart'));
app.get('/splitter', (req, res) => res.render('splitter'));

app.get('/word-counter', (req, res) => res.render('word-counter'));
app.get('/case-converter', (req, res) => res.render('case-converter'));
app.get('/text-diff', (req, res) => res.render('text-diff'));
app.get('/json-formatter', (req, res) => res.render('json-formatter'));
app.get('/base64', (req, res) => res.render('base64'));
app.get('/password-generator', (req, res) => res.render('password-generator'));
app.get('/lorem-ipsum', (req, res) => res.render('lorem-ipsum'));
app.get('/markdown-preview', (req, res) => res.render('markdown-preview'));
app.get('/csv-to-json', (req, res) => res.render('csv-to-json'));
app.get('/url-encode', (req, res) => res.render('url-encode'));

app.get('/regex-tester', (req, res) => res.render('regex-tester'));
app.get('/uuid-generator', (req, res) => res.render('uuid-generator'));
app.get('/hash-generator', (req, res) => res.render('hash-generator'));
app.get('/timestamp-converter', (req, res) => res.render('timestamp-converter'));
app.get('/color-converter', (req, res) => res.render('color-converter'));
app.get('/jwt-decoder', (req, res) => res.render('jwt-decoder'));
app.get('/base-converter', (req, res) => res.render('base-converter'));
app.get('/html-encoder', (req, res) => res.render('html-encoder'));
app.get('/dummy-json', (req, res) => res.render('dummy-json'));

app.get('/age-calculator', (req, res) => res.render('age-calculator'));
app.get('/bmi-calculator', (req, res) => res.render('bmi-calculator'));
app.get('/tip-calculator', (req, res) => res.render('tip-calculator'));
app.get('/countdown', (req, res) => res.render('countdown'));
app.get('/random-number', (req, res) => res.render('random-number'));
app.get('/coin-flip', (req, res) => res.render('coin-flip'));
app.get('/dice-roller', (req, res) => res.render('dice-roller'));
app.get('/unit-converter', (req, res) => res.render('unit-converter'));
app.get('/percentage', (req, res) => res.render('percentage'));
app.get('/days-between', (req, res) => res.render('days-between'));

app.get('/qr-generator', (req, res) => res.render('qr-generator'));
app.get('/remove-duplicates', (req, res) => res.render('remove-duplicates'));
app.get('/text-to-slug', (req, res) => res.render('text-to-slug'));
app.get('/meta-tags', (req, res) => res.render('meta-tags'));
app.get('/emoji-picker', (req, res) => res.render('emoji-picker'));
app.get('/cron-explainer', (req, res) => res.render('cron-explainer'));
app.get('/css-minifier', (req, res) => res.render('css-minifier'));
app.get('/find-replace', (req, res) => res.render('find-replace'));
app.get('/og-preview', (req, res) => res.render('og-preview'));
app.get('/tools/pdf-toolkit', (req, res) => res.render('pdf-toolkit'));

// 通用工具页
app.get('/tool/:id', requireLogin, (req, res) => {
  const tool = db.prepare('SELECT * FROM tools WHERE id = ?').get(req.params.id);
  if (!tool) return res.status(404).send('Tool not found');

  if (tool.tool_type === 'local' && tool.name === 'Word Counter') {
    return res.render('word-counter', { tool });
  }
  if (tool.tool_type === 'ai') {
    return res.render('ai-tool', { tool });
  }
  // 其他类型（比如你之前的 PDF）走原来的逻辑
  res.render('tool-detail', { tool }); // 或你原来的页面
});

// AI 工具 API（Gemini）
app.post('/api/ai-tool/:id', requireLogin, async (req, res) => {
  const tool = db.prepare('SELECT * FROM tools WHERE id = ?').get(req.params.id);
  if (!tool || tool.tool_type !== 'ai') return res.json({ success: false, error: 'Invalid tool' });

  let prompt = tool.prompt_template || '';
  prompt = prompt.replace('{{input}}', req.body.input || '');
  if (req.body.tone) prompt = prompt.replace('{{tone}}', req.body.tone);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{ text: prompt }]
          }]
        })
      }
    );

    const data = await response.json();
    const result = data.candidates?.[0]?.content?.parts?.[0]?.text || 'No result';
    res.json({ success: true, result });
  } catch (err) {
    console.error(err);
    res.json({ success: false, error: 'AI service error' });
  }
});

// PDF API
const pdfUpload = multer({ dest: '/tmp/pdf-uploads/' });
if (!fs.existsSync('/tmp/pdf-uploads')) fs.mkdirSync('/tmp/pdf-uploads', { recursive: true });

app.get('/pdf-tools', (req, res) => res.render('pdf-tools'));

app.post('/api/pdf/compress', pdfUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).send('No file');
  const level = req.body.level || 'ebook';
  const input = req.file.path;
  const output = input + '-compressed.pdf';
  const settings = { screen: '/screen', ebook: '/ebook', printer: '/printer' };
  try {
    await execAsync(`gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=${settings[level] || '/ebook'} -dNOPAUSE -dQUIET -dBATCH -sOutputFile="${output}" "${input}"`);
    res.download(output, 'compressed.pdf', () => {
      try { fs.unlinkSync(input); } catch(e){}
      try { fs.unlinkSync(output); } catch(e){}
    });
  } catch (err) {
    try { fs.unlinkSync(input); } catch(e){}
    res.status(500).send('Compression failed: ' + err.message);
  }
});

app.post('/api/pdf/merge', pdfUpload.array('files', 20), async (req, res) => {
  if (!req.files || req.files.length < 2) return res.status(400).send('Need at least 2 files');
  try {
    const merged = await PDFDocument.create();
    for (const file of req.files) {
      const bytes = fs.readFileSync(file.path);
      const doc = await PDFDocument.load(bytes);
      const pages = await merged.copyPages(doc, doc.getPageIndices());
      pages.forEach(p => merged.addPage(p));
      fs.unlinkSync(file.path);
    }
    const outBytes = await merged.save();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=merged.pdf');
    res.send(Buffer.from(outBytes));
  } catch (err) {
    req.files.forEach(f => { try { fs.unlinkSync(f.path); } catch(e){} });
    res.status(500).send('Merge failed: ' + err.message);
  }
});

app.post('/api/pdf/split', pdfUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).send('No file');
  const from = Math.max(1, parseInt(req.body.from) || 1);
  const to = Math.max(from, parseInt(req.body.to) || from);
  try {
    const bytes = fs.readFileSync(req.file.path);
    const src = await PDFDocument.load(bytes);
    const total = src.getPageCount();
    if (from > total) {
      fs.unlinkSync(req.file.path);
      return res.status(400).send(`PDF only has ${total} pages`);
    }
    const newDoc = await PDFDocument.create();
    const end = Math.min(to, total);
    const indices = [];
    for (let i = from - 1; i < end; i++) indices.push(i);
    const pages = await newDoc.copyPages(src, indices);
    pages.forEach(p => newDoc.addPage(p));
    const outBytes = await newDoc.save();
    fs.unlinkSync(req.file.path);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=split.pdf');
    res.send(Buffer.from(outBytes));
  } catch (err) {
    try { fs.unlinkSync(req.file.path); } catch(e){}
    res.status(500).send('Split failed: ' + err.message);
  }
});

// Tool request
app.post('/request-tool', (req, res) => {
  const { email, content } = req.body;
  if (email && content) {
    db.prepare('INSERT INTO tool_requests (email, content) VALUES (?, ?)').run(email, content);
  }
  res.redirect('/?requested=1');
});

// Admin
app.get('/admin', (req, res) => {
  if (req.session.isAdmin) return res.redirect('/admin/dashboard');
  res.render('admin-login', { error: null });
});

app.post('/admin/login', (req, res) => {
  if (req.body.password === 'admin123') {
    req.session.isAdmin = true;
    return res.redirect('/admin/dashboard');
  }
  res.render('admin-login', { error: 'Wrong password' });
});

app.get('/admin/dashboard', (req, res) => {
  if (!req.session.isAdmin) return res.redirect('/admin');
  const tools = db.prepare('SELECT * FROM tools ORDER BY id DESC').all();
  const users = db.prepare('SELECT id, email, created_at FROM users ORDER BY id DESC').all();
  res.render('admin', { tools, users });
});

app.post('/admin/add-tool', (req, res) => {
  if (!req.session.isAdmin) return res.redirect('/admin');
  const { name, description, category, url } = req.body;
  if (!name) return res.redirect('/admin/dashboard');
  db.prepare('INSERT INTO tools (name, description, category, url, type) VALUES (?, ?, ?, ?, "online")')
    .run(name, description || '', category || 'Other', url || '');
  res.redirect('/admin/dashboard');
});

app.post('/admin/delete-tool/:id', (req, res) => {
  if (!req.session.isAdmin) return res.redirect('/admin');
  db.prepare('DELETE FROM tools WHERE id = ?').run(req.params.id);
  res.redirect('/admin/dashboard');
});

app.post('/admin/delete-user/:id', (req, res) => {
  if (!req.session.isAdmin) return res.redirect('/admin');
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.redirect('/admin/dashboard');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ToolNest running on port ${PORT}`));
