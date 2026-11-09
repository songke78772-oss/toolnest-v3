require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const Database = require('better-sqlite3');
const crypto = require('crypto');

const app = express();

// Database
const db = new Database(path.join(__dirname, 'data', 'app.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    subscription_status TEXT DEFAULT 'inactive',
    creem_customer_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS tools (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    category TEXT DEFAULT '办公',
    url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS favorites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    tool_id INTEGER,
    UNIQUE(user_id, tool_id)
  );

  CREATE TABLE IF NOT EXISTS tool_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT,
    content TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Session
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Middleware
function requireLogin(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');
  next();
}

function requireSubscription(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');
  const user = db.prepare('SELECT subscription_status FROM users WHERE id = ?').get(req.session.userId);
  if (!user || user.subscription_status !== 'active') return res.redirect('/subscribe');
  next();
}

// Views
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Home
app.get('/', (req, res) => {
  const tools = db.prepare('SELECT * FROM tools ORDER BY id DESC').all();
  res.render('index', { tools, loggedIn: !!req.session.userId });
});

// Auth
app.get('/login', (req, res) => res.render('login', { error: null }));
app.post('/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.render('login', { error: '邮箱或密码错误' });
  }
  req.session.userId = user.id;
  res.redirect('/dashboard');
});

app.get('/register', (req, res) => res.render('register', { error: null }));
app.post('/register', (req, res) => {
  const { email, password } = req.body;
  try {
    const hash = bcrypt.hashSync(password, 10);
    db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run(email, hash);
    res.redirect('/login');
  } catch {
    res.render('register', { error: '邮箱已存在' });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// Dashboard
app.get('/dashboard', requireLogin, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  const favorites = db.prepare(`
    SELECT tools.* FROM favorites
    JOIN tools ON favorites.tool_id = tools.id
    WHERE favorites.user_id = ?
  `).all(req.session.userId);
  res.render('dashboard', { user, favorites });
});

// Subscribe
app.get('/subscribe', requireLogin, (req, res) => {
  res.render('subscribe');
});

app.post('/subscribe', requireLogin, async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  try {
    const response = await fetch('https://api.creem.io/v1/checkouts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.CREEM_API_KEY
      },
      body: JSON.stringify({
        product_id: process.env.CREEM_PRODUCT_ID,
        success_url: 'https://protoolnest.com/success',
        customer_email: user.email
      })
    });
    const data = await response.json();
    if (data.checkout_url) {
      return res.redirect(data.checkout_url);
    }
    res.send('创建支付失败');
  } catch (err) {
    console.error(err);
    res.send('支付出错');
  }
});

// Success
app.get('/success', requireLogin, (req, res) => {
  res.render('success');
});

// Webhook
app.post('/webhook/creem', express.raw({ type: 'application/json' }), (req, res) => {
  const signature = req.headers['creem-signature'];
  const secret = process.env.CREEM_WEBHOOK_SECRET;
  const payload = req.body.toString();

  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  if (signature !== expected) return res.status(401).send('Invalid signature');

  const event = JSON.parse(payload);
  if (event.type === 'checkout.completed' || event.type === 'subscription.paid') {
    const email = event.data?.customer?.email;
    if (email) {
      db.prepare("UPDATE users SET subscription_status = 'active' WHERE email = ?").run(email);
    }
  }
  if (event.type === 'subscription.canceled' || event.type === 'subscription.expired') {
    const email = event.data?.customer?.email;
    if (email) {
      db.prepare("UPDATE users SET subscription_status = 'inactive' WHERE email = ?").run(email);
    }
  }
  res.json({ received: true });
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
const ADMIN_PASSWORD = 'admin123';

app.get('/admin', (req, res) => {
  if (req.session.isAdmin) return res.redirect('/admin/dashboard');
  res.render('admin-login', { error: null });
});

app.post('/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return res.redirect('/admin/dashboard');
  }
  res.render('admin-login', { error: '密码错误' });
});

app.get('/admin/dashboard', (req, res) => {
  if (!req.session.isAdmin) return res.redirect('/admin');
  const tools = db.prepare('SELECT * FROM tools').all();
  res.render('admin', { tools });
});

app.post('/admin/add-tool', (req, res) => {
  if (!req.session.isAdmin) return res.redirect('/admin');
  const { name, description, category, url } = req.body;
  db.prepare('INSERT INTO tools (name, description, category, url) VALUES (?, ?, ?, ?)').run(name, description, category, url);
  res.redirect('/admin/dashboard');
});

// Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ToolNest running on port ${PORT}`);
});
