const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// 内存房间存储
const rooms = new Map();

// 名字池
const namePools = {
  animal: ['Lion', 'Tiger', 'Bear', 'Wolf', 'Fox', 'Deer', 'Eagle', 'Owl', 'Rabbit', 'Panda', 'Koala', 'Dolphin'],
  fruit: ['Apple', 'Banana', 'Orange', 'Grape', 'Mango', 'Peach', 'Cherry', 'Lemon', 'Kiwi', 'Melon', 'Pear', 'Plum'],
  vegetable: ['Carrot', 'Potato', 'Tomato', 'Onion', 'Cabbage', 'Broccoli', 'Spinach', 'Pepper', 'Corn', 'Bean', 'Pea', 'Radish']
};

function generateId() {
  return crypto.randomBytes(8).toString('hex');
}

function getAvailableNames(category, usedNames) {
  const pool = namePools[category] || namePools.animal;
  return pool.filter(name => !usedNames.has(name));
}

// 创建房间（需要登录，实际使用时请加上你的登录校验中间件）
app.post('/api/create-room', (req, res) => {
  const { maxPeople, hours, category, creatorName, deepEncrypt, password } = req.body;

  if (!maxPeople || maxPeople < 1 || maxPeople > 10) {
    return res.status(400).json({ error: '人数必须在 1-10 之间' });
  }
  if (![1, 2, 5].includes(Number(hours))) {
    return res.status(400).json({ error: '时长只能是 1、2 或 5 小时' });
  }
  if (!namePools[category]) {
    return res.status(400).json({ error: '无效的名字分类' });
  }
  if (!creatorName || !namePools[category].includes(creatorName)) {
    return res.status(400).json({ error: '请从分类中选择创建者名字' });
  }
  if (deepEncrypt && (!password || password.length > 5)) {
    return res.status(400).json({ error: '深度加密密码最多 5 位' });
  }

  const roomId = generateId();
  const expireAt = Date.now() + hours * 60 * 60 * 1000;
  const usedNames = new Set([creatorName]);

  const inviteLinks = [];
  for (let i = 0; i < maxPeople - 1; i++) {
    const token = generateId();
    inviteLinks.push({
      token,
      url: `/join/${roomId}/${token}`
    });
  }

  rooms.set(roomId, {
    id: roomId,
    maxPeople: Number(maxPeople),
    hours: Number(hours),
    category,
    creatorName,
    deepEncrypt: !!deepEncrypt,
    password: deepEncrypt ? password : null,
    expireAt,
    users: new Map(),
    messages: [],
    usedTokens: new Set(),
    availableTokens: new Set(inviteLinks.map(l => l.token)),
    dissolved: false
  });

  // 自动过期清理
  setTimeout(() => {
    if (rooms.has(roomId)) {
      io.to(roomId).emit('system', '房间已到期，自动解散');
      rooms.delete(roomId);
    }
  }, hours * 60 * 60 * 1000);

  res.json({
    roomId,
    creatorName,
    inviteLinks,
    expireAt
  });
});

// 验证并进入房间
app.post('/api/join/:roomId/:token', (req, res) => {
  const { roomId, token } = req.params;
  const { password } = req.body;
  const room = rooms.get(roomId);

  if (!room || room.dissolved || room.expireAt < Date.now()) {
    return res.status(404).json({ error: '房间不存在或已过期' });
  }
  if (!room.availableTokens.has(token)) {
    return res.status(403).json({ error: '邀请链接无效或已被使用' });
  }
  if (room.deepEncrypt && room.password !== password) {
    return res.status(401).json({ error: '密码错误' });
  }
  if (room.users.size >= room.maxPeople) {
    return res.status(403).json({ error: '房间已满' });
  }

  // 标记链接已使用
  room.availableTokens.delete(token);
  room.usedTokens.add(token);

  res.json({ ok: true, roomId, category: room.category });
});

app.get('/join/:roomId/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'join.html'));
});

app.get('/room/:roomId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'room.html'));
});

io.on('connection', (socket) => {
  socket.on('join-room', ({ roomId, isCreator, name }) => {
    const room = rooms.get(roomId);
    if (!room || room.dissolved) {
      return socket.emit('error', '房间不存在');
    }

    let displayName = name;
    if (!isCreator) {
      const available = getAvailableNames(room.category, new Set([...room.users.values(), room.creatorName]));
      if (available.length === 0) {
        return socket.emit('error', '没有可用名字');
      }
      displayName = available[Math.floor(Math.random() * available.length)];
    }

    room.users.set(socket.id, displayName);
    socket.join(roomId);
    socket.roomId = roomId;
    socket.isCreator = isCreator;

    io.to(roomId).emit('system', `${displayName} 加入了房间`);
    socket.emit('joined', { name: displayName, expireAt: room.expireAt });
    socket.emit('history', room.messages.slice(-100));
  });

  socket.on('message', ({ roomId, ciphertext }) => {
    const room = rooms.get(roomId);
    if (!room || !room.users.has(socket.id)) return;

    const msg = {
      name: room.users.get(socket.id),
      ciphertext,
      time: Date.now()
    };
    room.messages.push(msg);
    if (room.messages.length > 300) room.messages.shift();

    io.to(roomId).emit('message', msg);
  });

  socket.on('dissolve', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (room && socket.isCreator) {
      room.dissolved = true;
      io.to(roomId).emit('system', '房间已被创建者解散');
      rooms.delete(roomId);
      io.in(roomId).disconnectSockets();
    }
  });

  socket.on('disconnect', () => {
    if (!socket.roomId) return;
    const room = rooms.get(socket.roomId);
    if (room && room.users.has(socket.id)) {
      const name = room.users.get(socket.id);
      room.users.delete(socket.id);
      io.to(socket.roomId).emit('system', `${name} 已经离会`);
    }
  });
});

const PORT = process.env.PORT || 3002;
server.listen(PORT, () => {
  console.log(`Burn Chat running on port ${PORT}`);
});
