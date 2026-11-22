require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const Database = require('better-sqlite3');
const { PDFDocument } = require('pdf-lib');
const { exec } = require('child_process');
const { promisify } = require('util');
const { Resend } = require('resend');
const axios = require('axios');
const execAsync = promisify(exec);

const app = express();
const resend = new Resend(process.env.RESEND_API_KEY);
const verificationCodes = new Map();

const db = new Database(path.join(__dirname, 'data', 'app.db'));

// 确保 AI 工具需要的字段存在
try { db.exec(`ALTER TABLE tools ADD COLUMN tool_type TEXT DEFAULT 'link'`); } catch (e) {}
try { db.exec(`ALTER TABLE tools ADD COLUMN icon TEXT DEFAULT '🔧'`); } catch (e) {}
try { db.exec(`ALTER TABLE tools ADD COLUMN prompt_template TEXT`); } catch (e) {}
try { db.exec(`ALTER TABLE tools ADD COLUMN input_placeholder TEXT`); } catch (e) {}


// Ensure required columns exist
try { db.exec(`ALTER TABLE users ADD COLUMN trial_end_at DATETIME`); } catch (e) {}
try { db.exec(`ALTER TABLE users ADD COLUMN plan TEXT DEFAULT 'free'`); } catch (e) {}
try { db.exec(`ALTER TABLE users ADD COLUMN stripe_customer_id TEXT`); } catch (e) {}
try { db.exec(`ALTER TABLE users ADD COLUMN current_period_end DATETIME`); } catch (e) {}

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
    tool_type TEXT DEFAULT 'link',
    prompt_template TEXT,
    input_placeholder TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS secrets (
    token TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    iv TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
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
// Sitemap with correct content type
app.get('/sitemap.xml', (req, res) => {
  res.type('application/xml');
  res.sendFile(path.join(__dirname, 'public', 'sitemap.xml'));
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/templates', express.static(path.join(__dirname, 'templates')));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

function requireLogin(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');
  next();
}

function hasAccess(user) {
  if (!user) return false;
  if (user.subscription_status === 'active') return true;
  if (user.trial_end_at && new Date() < new Date(user.trial_end_at)) return true;
  return false;
}

function requireAccess(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!user || !hasAccess(user)) return res.redirect('/subscribe');
  next();
}

// ========== 路由模块 ==========
const legalRoutes = require('./routes/legal');
app.use('/api/legal', legalRoutes);

//const audioRoutes = require('./routes/audio');
//app.use('/', requireAccess, audioRoutes);

const audioRoutes = require('./routes/audio');
app.use((req, res, next) => {
  if (req.path.startsWith('/audio-converter') || req.path.startsWith('/api/audio')) {
    return requireAccess(req, res, next);
  }
  next();
});

app.use('/', audioRoutes);


// Static pages
app.get('/tools', (req, res) => res.render('tools'));
app.get('/pricing', (req, res) => res.render('pricing'));
app.get('/pdf-toolkit', (req, res) => res.render('pdf-toolkit'));

// Home
app.get('/', (req, res) => {
  const tools = db.prepare('SELECT * FROM tools ORDER BY id DESC').all();

  // 统计各分类数量
  const categoryCounts = db.prepare(`
    SELECT category, COUNT(*) as count 
    FROM tools 
    GROUP BY category
  `).all();

  const counts = {};
  categoryCounts.forEach(row => {
    counts[row.category] = row.count;
  });

  let trialInfo = null;
  if (req.session.userId) {
    const user = db.prepare('SELECT trial_end_at, subscription_status FROM users WHERE id = ?').get(req.session.userId);
    if (user && user.subscription_status !== 'active' && user.trial_end_at) {
      const end = new Date(user.trial_end_at);
      if (end > new Date()) {
        trialInfo = { endDate: end.toLocaleDateString('zh-CN') };
      }
    }
  }

  res.render('index', { 
    loggedIn: !!req.session.userId, 
    user: req.session.userId, 
    tools, 
    counts,          // 传给前端
    q: req.query.q || '', 
    trialInfo 
  });
});

// Register
app.get('/register', (req, res) => {
  try {
    res.render('register', { error: null });
  } catch (e) {
    console.error('Register page error:', e);
    res.status(500).send('Register page error: ' + e.message);
  }
});

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
    const trialEnd = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(`
      INSERT INTO users (email, password_hash, trial_end_at, subscription_status, plan)
      VALUES (?, ?, ?, 'trial', 'free')
    `).run(email, hash, trialEnd);
    verificationCodes.delete(email);
    res.redirect('/login');
  } catch (err) {
    res.render('register', { error: 'Email already exists' });
  }
});

// Login / Logout
app.get('/login', (req, res) => {
  try {
    res.render('login', { error: null, verified: false });
  } catch (e) {
    console.error('Login page error:', e);
    res.status(500).send('Login page error: ' + e.message);
  }
});

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

app.get('/subscribe', requireLogin, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  res.render('subscribe', { user });
});

// ===== 统一工具入口 =====
app.get('/tool/:id', requireAccess, (req, res) => {
  const tool = db.prepare('SELECT * FROM tools WHERE id = ?').get(req.params.id);
  if (!tool) return res.status(404).send('Tool not found');

  if (tool.name === 'Word Counter' || tool.tool_type === 'local') {
    return res.render('word-counter', { tool });
  }
  if (tool.tool_type === 'ai') {
    return res.render('ai-tool', { tool });
  }
  if (tool.url) {
    return res.redirect(tool.url);
  }
  res.status(404).send('Tool page not configured');
});

// AI 工具 API
app.post('/api/ai-tool/:id', requireAccess, async (req, res) => {
  const tool = db.prepare('SELECT * FROM tools WHERE id = ?').get(req.params.id);
  if (!tool || tool.tool_type !== 'ai') {
    return res.json({ success: false, error: 'Invalid tool' });
  }

  let prompt = tool.prompt_template || '';
  prompt = prompt.replace(/\{\{input\}\}/g, req.body.input || '');
  if (req.body.tone) prompt = prompt.replace(/\{\{tone\}\}/g, req.body.tone);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      }
    );

    const data = await response.json();
    if (data.error) {
      console.error('Gemini error:', data.error);
      return res.json({ success: false, error: data.error.message || 'AI error' });
    }
    const result = data.candidates?.[0]?.content?.parts?.[0]?.text || 'No result';
    res.json({ success: true, result });
  } catch (err) {
    console.error(err);
    res.json({ success: false, error: 'AI service error' });
  }
});

app.get('/terms', (req, res) => res.render('terms'));
app.get('/privacy', (req, res) => res.render('privacy'));
app.get('/refund', (req, res) => res.render('refund'));
app.get('/disclaimer', (req, res) => res.render('disclaimer'));

// ========== 法律文书页面 ==========
app.get('/tools/legal-document', requireLogin, (req, res) => {
  res.render('legal-document');
});

app.get('/tools/legal/:type', requireLogin, (req, res) => {
  res.render(`legal/${req.params.type}`);
});

// ===== 原有内置工具页面 =====
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


//安全工具
app.get('/file-encrypt', (req, res) => res.render('file-encrypt'));
app.get('/cipherdeck', (req, res) => res.render('cipherdeck'));
app.get('/image-metadata', requireLogin, (req, res) => {
  res.render('image-metadata');
});

// File Transfer - Create Room Page (需要登录)
app.get('/file-transfer', requireLogin, (req, res) => {
  res.render('file-transfer');
});

// File Transfer - Create Room (需要登录)
app.post('/file-transfer/create', requireLogin, (req, res) => {
  const { maxParticipants, duration, encryption } = req.body;
  
  const roomId = Math.random().toString(36).substring(2, 10);
  const inviteLink = `https://${req.get('host')}/file-room/${roomId}`;
  
  res.render('file-room', { 
    inviteLink,
    roomId,
    maxParticipants,
    duration,
    encryption: encryption === 'on',
    isHost: true
  });
});

// File Transfer - Join Room (不需要登录)
app.get('/file-room/:roomId', (req, res) => {
  const { roomId } = req.params;
  const inviteLink = `https://${req.get('host')}/file-room/${roomId}`;
  
  res.render('file-room', { 
    inviteLink,
    roomId,
    maxParticipants: 5,
    duration: 2,
    encryption: false,
    isHost: false
  });
});
// ========== File Transfer File Handling ==========
const roomUploadDir = path.join(__dirname, 'uploads', 'rooms');
if (!fs.existsSync(roomUploadDir)) {
  fs.mkdirSync(roomUploadDir, { recursive: true });
}

const roomStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const roomPath = path.join(roomUploadDir, req.body.roomId || 'temp');
    if (!fs.existsSync(roomPath)) fs.mkdirSync(roomPath, { recursive: true });
    cb(null, roomPath);
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname);
  }
});
const roomUpload = multer({ storage: roomStorage });

// Upload file to room
app.post('/file-transfer/upload', roomUpload.single('file'), (req, res) => {
  res.json({ success: true });
});

// List files in room
app.get('/file-transfer/files/:roomId', (req, res) => {
  const roomPath = path.join(roomUploadDir, req.params.roomId);
  if (!fs.existsSync(roomPath)) return res.json({ files: [] });
  
  const files = fs.readdirSync(roomPath).map(name => ({ name }));
  res.json({ files });
});

// Download file from room
app.get('/file-transfer/download/:roomId/:filename', (req, res) => {
  const filePath = path.join(roomUploadDir, req.params.roomId, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('File not found');
  res.download(filePath);
});


app.get('/word-counter', (req, res) => res.render('word-counter'));
app.get('/case-converter', (req, res) => {
  try {
    res.render('case-converter');
  } catch (e) {
    console.error('case-converter error:', e);
    res.status(500).send('case-converter error: ' + e.message);
  }
});
app.get('/text-diff', (req, res) => {
  try {
    res.render('text-diff');
  } catch (e) {
    console.error('text-diff error:', e);
    res.status(500).send('text-diff error: ' + e.message);
  }
});
app.get('/json-formatter', (req, res) => {
  try {
    res.render('json-formatter');
  } catch (e) {
    console.error('json-formatter error:', e);
    res.status(500).send('json-formatter error: ' + e.message);
  }
});
app.get('/base64', (req, res) => res.render('base64'));
app.get('/password-generator', (req, res) => res.render('password-generator'));
app.get('/lorem-ipsum', (req, res) => {
  try {
    res.render('lorem-ipsum');
  } catch (e) {
    console.error('lorem-ipsum error:', e);
    res.status(500).send('lorem-ipsum error: ' + e.message);
  }
});
app.get('/markdown-preview', (req, res) => {
  try {
    res.render('markdown-preview');
  } catch (e) {
    console.error('markdown-preview error:', e);
    res.status(500).send('markdown-preview error: ' + e.message);
  }
});
app.get('/csv-to-json', (req, res) => res.render('csv-to-json'));
app.get('/url-encode', (req, res) => res.render('url-encode'));

app.get('/regex-tester', (req, res) => {
  try {
    res.render('regex-tester');
  } catch (e) {
    console.error('regex-tester error:', e);
    res.status(500).send('regex-tester error: ' + e.message);
  }
});
app.get('/uuid-generator', (req, res) => {
  try {
    res.render('uuid-generator');
  } catch (e) {
    console.error('uuid-generator error:', e);
    res.status(500).send('uuid-generator error: ' + e.message);
  }
});
app.get('/hash-generator', (req, res) => {
  try {
    res.render('hash-generator');
  } catch (e) {
    console.error('hash-generator error:', e);
    res.status(500).send('hash-generator error: ' + e.message);
  }
});
app.get('/timestamp-converter', (req, res) => res.render('timestamp-converter'));
app.get('/color-converter', (req, res) => res.render('color-converter'));
app.get('/jwt-decoder', (req, res) => res.render('jwt-decoder'));
app.get('/base-converter', (req, res) => res.render('base-converter'));
app.get('/html-encoder', (req, res) => res.render('html-encoder'));
app.get('/dummy-json', (req, res) => res.render('dummy-json'));

app.get('/age-calculator', (req, res) => {
  try {
    res.render('age-calculator');
  } catch (e) {
    console.error('age-calculator error:', e);
    res.status(500).send('age-calculator error: ' + e.message);
  }
});
app.get('/bmi-calculator', (req, res) => res.render('bmi-calculator'));
app.get('/tip-calculator', (req, res) => res.render('tip-calculator'));
app.get('/countdown', (req, res) => res.render('countdown'));
app.get('/random-number', (req, res) => res.render('random-number'));
app.get('/coin-flip', (req, res) => res.render('coin-flip'));
app.get('/dice-roller', (req, res) => res.render('dice-roller'));
app.get('/unit-converter', (req, res) => res.render('unit-converter'));
app.get('/percentage', (req, res) => res.render('percentage'));
app.get('/days-between', (req, res) => res.render('days-between'));

app.get('/qr-generator', (req, res) => {
  try {
    res.render('qr-generator');
  } catch (e) {
    console.error('qr-generator error:', e);
    res.status(500).send('qr-generator error: ' + e.message);
  }
});
app.get('/remove-duplicates', (req, res) => res.render('remove-duplicates'));
app.get('/text-to-slug', (req, res) => res.render('text-to-slug'));
app.get('/meta-tags', (req, res) => {
  try {
    res.render('meta-tags');
  } catch (e) {
    console.error('meta-tags error:', e);
    res.status(500).send('meta-tags error: ' + e.message);
  }
});
app.get('/emoji-picker', (req, res) => res.render('emoji-picker'));
app.get('/cron-explainer', (req, res) => res.render('cron-explainer'));
app.get('/css-minifier', (req, res) => {
  try {
    res.render('css-minifier');
  } catch (e) {
    console.error('css-minifier error:', e);
    res.status(500).send('css-minifier error: ' + e.message);
  }
});
app.get('/find-replace', (req, res) => res.render('find-replace'));
app.get('/og-preview', (req, res) => res.render('og-preview'));
app.get('/tools/pdf-toolkit', (req, res) => res.render('pdf-toolkit'));

// PDF API
const pdfUpload = multer({ dest: '/tmp/pdf-uploads/' });
if (!fs.existsSync('/tmp/pdf-uploads')) fs.mkdirSync('/tmp/pdf-uploads', { recursive: true });

app.get('/pdf-tools', (req, res) => {
  try {
    res.render('pdf-tools');
  } catch (e) {
    console.error('pdf-tools error:', e);
    res.status(500).send('pdf-tools error: ' + e.message);
  }
});

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

// Creem 支付
app.post('/create-checkout', requireLogin, async (req, res) => {
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    const response = await axios.post(
      'https://api.creem.io/v1/checkouts',
      {
        product_id: process.env.CREEM_PRODUCT_ID,
        success_url: 'https://protoolnest.com/success',
        customer: { email: user.email },
        metadata: { userId: String(user.id) }
      },
      {
        headers: {
          'x-api-key': process.env.CREEM_API_KEY,
          'Content-Type': 'application/json'
        }
      }
    );
    res.json({ url: response.data.checkout_url });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to create checkout' });
  }
});

app.get('/success', requireLogin, (req, res) => {
  const { subscription_id, customer_id } = req.query;
  if (subscription_id) {
    try {
      db.prepare(`
        UPDATE users 
        SET subscription_status = 'active',
            subscription_id = ?,
            stripe_customer_id = ?,
            current_period_end = datetime('now', '+30 days')
        WHERE id = ?
      `).run(subscription_id, customer_id || '', req.session.userId);
    } catch (e) {
      console.error('Update subscription error:', e);
    }
  }
  res.render('success');
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
  const { name, description, category, url, icon } = req.body;
  if (!name) return res.redirect('/admin/dashboard');

  db.prepare(`
    INSERT INTO tools (name, description, category, url, icon)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    name,
    description || '',
    category || 'Other',
    url || '',
    icon || '🔧'
  );

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

// One-Time Secret (encrypted, burn after reading, no logging)
app.get('/one-time-secret', (req, res) => res.render('one-time-secret'));

app.post('/api/secret', express.json(), (req, res) => {
  const { data, iv, ttl } = req.body;
  if (!data || !iv) return res.status(400).json({ error: 'Missing data' });
  const token = require('crypto').randomBytes(16).toString('hex');
  const expires = Math.floor(Date.now() / 1000) + (ttl || 86400);
  db.prepare('INSERT INTO secrets (token, data, iv, expires_at) VALUES (?, ?, ?, ?)').run(token, data, iv, expires);
  res.json({ token });
});

app.get('/api/secret/:token', (req, res) => {
  const row = db.prepare('SELECT data, iv, expires_at FROM secrets WHERE token = ?').get(req.params.token);
  if (!row) return res.status(404).send('Secret not found or already viewed');
  if (row.expires_at < Math.floor(Date.now() / 1000)) {
    db.prepare('DELETE FROM secrets WHERE token = ?').run(req.params.token);
    return res.status(410).send('Secret expired');
  }
  // Burn after reading
  db.prepare('DELETE FROM secrets WHERE token = ?').run(req.params.token);
  res.set('Cache-Control', 'no-store');
  res.json({ data: row.data, iv: row.iv });
});

app.get('/secret/:token', (req, res) => res.render('one-time-secret'));


// Office Metadata Cleaner
const JSZip = require('jszip');
const uploadMeta = multer({ dest: '/tmp/office-meta/', limits: { fileSize: 20 * 1024 * 1024 } });
require('fs').mkdirSync('/tmp/office-meta', { recursive: true });

function extractTags(xml, prefix) {
  const meta = [];
  if (!xml) return meta;
  const re = /<([a-zA-Z0-9:]+)[^>]*>([^<]*)<\/\1>/g;
  let m;
  while ((m = re.exec(xml))) {
    const tag = m[1];
    const val = m[2].trim();
    if (val && val.length < 500) {
      const shortTag = tag.includes(':') ? tag.split(':').pop() : tag;
      meta.push({
        key: prefix + ':' + shortTag,
        name: prefix + ' / ' + shortTag,
        value: val
      });
    }
  }
  return meta;
}

function parseOfficeMetadata(buffer) {
  return JSZip.loadAsync(buffer).then(zip => {
    const meta = [];
    const targets = [
      { path: 'docProps/core.xml', prefix: 'core' },
      { path: 'docProps/app.xml', prefix: 'app' },
      { path: 'docProps/custom.xml', prefix: 'custom' }
    ];
    return Promise.all(targets.map(t => {
      const f = zip.file(t.path);
      return f ? f.async('string').then(xml => ({ xml, prefix: t.prefix })) : Promise.resolve(null);
    })).then(results => {
      results.forEach(r => {
        if (r && r.xml) meta.push(...extractTags(r.xml, r.prefix));
      });
      return meta;
    });
  });
}

app.get('/office-metadata', (req, res) => res.render('office-metadata'));

app.post('/api/office-metadata/parse', uploadMeta.single('file'), async (req, res) => {
  if (!req.file) return res.json({ success: false, error: 'No file' });
  try {
    const buf = require('fs').readFileSync(req.file.path);
    const metadata = await parseOfficeMetadata(buf);
    require('fs').unlinkSync(req.file.path);
    res.json({ success: true, metadata });
  } catch (e) {
    if (req.file) try { require('fs').unlinkSync(req.file.path); } catch {}
    res.json({ success: false, error: e.message });
  }
});

app.post('/api/office-metadata/clean', uploadMeta.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).send('No file');
  try {
    const remove = JSON.parse(req.body.remove || '[]');
    const buf = require('fs').readFileSync(req.file.path);
    const zip = await JSZip.loadAsync(buf);

    const files = [
      { path: 'docProps/core.xml', prefix: 'core:' },
      { path: 'docProps/app.xml', prefix: 'app:' },
      { path: 'docProps/custom.xml', prefix: 'custom:' }
    ];
    for (const f of files) {
      const file = zip.file(f.path);
      if (!file) continue;
      let xml = await file.async('string');
      remove.filter(k => k.startsWith(f.prefix)).forEach(k => {
        const tag = k.slice(f.prefix.length);
        const re = new RegExp('<([a-zA-Z0-9:]*:?)' + tag + '([^>]*)>[^<]*</\\1' + tag + '>', 'g');
        xml = xml.replace(re, '<$1' + tag + '$2></$1' + tag + '>');
      });
      zip.file(f.path, xml);
    }

    const out = await zip.generateAsync({ type: 'nodebuffer' });
    require('fs').unlinkSync(req.file.path);
    res.set('Content-Disposition', 'attachment; filename="clean-' + (req.file.originalname || 'file') + '"');
    res.set('Content-Type', 'application/octet-stream');
    res.send(out);
  } catch (e) {
    if (req.file) try { require('fs').unlinkSync(req.file.path); } catch {}
    res.status(500).send(e.message);
  }
});

app.listen(PORT, () => console.log(`ToolNest running on port ${PORT}`));
