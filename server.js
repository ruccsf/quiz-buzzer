const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '1mb' })); // 用于接收 base64 头像
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

// 头像存储目录
const AVATAR_DIR = path.join(__dirname, 'public', 'avatars');
if (!fs.existsSync(AVATAR_DIR)) fs.mkdirSync(AVATAR_DIR, { recursive: true });

// POST /api/upload-avatar  — 选手上传头像（base64 → 文件）
app.post('/api/upload-avatar', (req, res) => {
  try {
    const { contestantId, image } = req.body;
    if (!contestantId || !image) return res.status(400).json({ ok: false, error: '参数不足' });

    // 校验图片格式 base64
    const matches = image.match(/^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,(.+)$/);
    if (!matches) return res.status(400).json({ ok: false, error: '图片格式不支持' });

    const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1] === 'svg+xml' ? 'svg' : matches[1];
    const buffer = Buffer.from(matches[2], 'base64');
    // 限制单文件最大 500KB
    if (buffer.length > 512000) return res.status(413).json({ ok: false, error: '图片太大' });

    const fileName = contestantId + '.' + ext;
    fs.writeFileSync(path.join(AVATAR_DIR, fileName), buffer);

    const avatarUrl = '/avatars/' + fileName + '?t=' + Date.now();

    // 通知房间更新头像（需要知道选手在哪个房间）
    // 房间信息通过 body 传入或在服务端查找
    const { roomCode } = req.body;
    if (roomCode) {
      const room = getRoom(roomCode);
      if (room) {
        const contestant = room.contestants.find(c => c.id === contestantId);
        if (contestant) {
          contestant.avatar = avatarUrl;
        }
      }
      io.to(roomCode).emit('avatar-updated', { contestantId, avatarUrl });
    }

    res.json({ ok: true, avatarUrl });
  } catch (err) {
    console.error('上传头像失败:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 清理选手头像文件
function deleteAvatarFile(contestantId) {
  if (!contestantId) return;
  const files = fs.readdirSync(AVATAR_DIR);
  for (const f of files) {
    if (f.startsWith(contestantId + '.')) {
      fs.unlinkSync(path.join(AVATAR_DIR, f));
    }
  }
}

// 路由：无后缀页面路径 → HTML 文件（禁用缓存）
app.get(['/host', '/contestant', '/screen', '/player', '/questions'], (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(__dirname + '/public' + req.path + '.html');
});

app.use(express.static('public', {
  setHeaders: (res, path) => {
    if (path.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  },
}));

// ======== 持久化存储 ========
const DATA_FILE = path.join(__dirname, 'rooms-data.json');
let savePending = false;

function saveRooms() {
  // 去抖：如果已经有写入了，不重复排队
  if (savePending) return;
  savePending = true;

  setImmediate(() => {
    savePending = false;
    try {
      // 只保存可序列化的数据，去掉运行时状态
      const data = {};
      for (const [code, room] of Object.entries(rooms)) {
        data[code] = {
          id: room.id,
          gameName: room.gameName,
          hostSocketId: null,          // 运行时状态，不持久化
          contestants: room.contestants.map(c => ({
            id: c.id,
            name: c.name,
            score: c.score,
            color: c.color,
            avatar: c.avatar || '',
            socketId: null,            // 运行时状态，不持久化
          })),
          state: 'idle',               // 重启后一律回到 idle
          timer: room.timer,
          timerRemaining: 0,
          currentBuzzer: null,
          buzzHistory: room.buzzHistory,
          round: room.round,
          usedQuestionIds: room.usedQuestionIds || [],
        };
      }
      fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      console.error('保存房间数据失败:', err.message);
    }
  });
}

function loadRooms() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const data = JSON.parse(raw);
    let loaded = 0;
    for (const [code, saved] of Object.entries(data)) {
      rooms[code] = {
        ...saved,
        gameName: saved.gameName || saved.hostName || '知识竞赛', // 兼容旧版 hostName 字段
        hostSocketId: null,
        timerInterval: null,
        usedQuestionIds: saved.usedQuestionIds || [],
        // 确保 contestants 的 socketId 是 null, avatar 有默认值
        contestants: (saved.contestants || []).map(c => ({ ...c, socketId: null, avatar: c.avatar || '' })),
      };
      loaded++;
    }
    if (loaded > 0) {
      console.log(`📂 已恢复 ${loaded} 个房间的数据`);
    }
  } catch (err) {
    console.error('加载房间数据失败:', err.message);
  }
}

// ======== 配置 ========
const CONFIG_FILE = path.join(__dirname, 'config.json');
let config = { adminPassword: '1234' };

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
      return;
    }
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    config = { ...config, ...JSON.parse(raw) };
  } catch (err) {
    console.error('加载配置失败:', err.message);
  }
}
loadConfig();

// ======== 题库持久化 ========
const QUESTIONS_FILE = path.join(__dirname, 'questions-data.json');
let questionSavePending = false;
let questionBank = {};

function saveQuestions() {
  if (questionSavePending) return;
  questionSavePending = true;
  setImmediate(() => {
    questionSavePending = false;
    try {
      fs.writeFileSync(QUESTIONS_FILE, JSON.stringify(questionBank, null, 2), 'utf8');
    } catch (err) {
      console.error('保存题库失败:', err.message);
    }
  });
}

function loadQuestions() {
  try {
    if (!fs.existsSync(QUESTIONS_FILE)) return;
    const raw = fs.readFileSync(QUESTIONS_FILE, 'utf8');
    questionBank = JSON.parse(raw);
    const count = Object.values(questionBank).reduce((sum, arr) => sum + arr.length, 0);
    if (count > 0) console.log(`📚 已恢复 ${count} 道题库数据`);
  } catch (err) {
    console.error('加载题库失败:', err.message);
  }
}

function genQId() {
  return 'q_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ======== 游戏状态 ========
const rooms = {};

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms[code]);
  return code;
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

const COLORS = ['#FF6B6B', '#4ECDC4', '#FFE66D', '#A8E6CF', '#FF8A5C', '#7C4DFF', '#00BCD4', '#FF4081'];

function createRoom(gameName) {
  const code = generateRoomCode();
  rooms[code] = {
    id: code,
    gameName,
    hostSocketId: null,
    contestants: [],
    state: 'idle',       // idle | open | locked | resolved
    timer: 10,
    timerInterval: null,
    timerRemaining: 0,
    currentBuzzer: null,
    currentQuestion: '',
    currentAnswer: '',
    currentQuestionId: null,
    usedQuestionIds: [],
    buzzHistory: [],
    round: 0,
  };
  saveRooms();  // 立即保存
  return rooms[code];
}

function getRoom(code) {
  return rooms[code];
}

function deleteRoom(code) {
  const room = rooms[code];
  if (room) {
    clearInterval(room.timerInterval);
    delete rooms[code];
    saveRooms();
  }
}

// 重启后重建房间列表时，清空过期房间（超过24小时）
function cleanupOldRooms() {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  for (const [code, room] of Object.entries(rooms)) {
    // 如果房间没选手、没主持人，且最晚一条记录超过24小时，清理
    if (room.contestants.length === 0 && !room.hostSocketId) {
      const lastEntry = room.buzzHistory?.[room.buzzHistory.length - 1];
      if (lastEntry && now - lastEntry.timestamp > day) {
        delete rooms[code];
      }
    }
  }
}

// ======== Socket.IO ========
io.on('connection', (socket) => {
  let currentRoom = null;
  let currentContestantId = null;

  // ---- 列出活跃房间（host 页面显示全部，首页只显示可加入的） ----
  socket.on('list-rooms', (data, callback) => {
    if (typeof callback !== 'function') callback = data;
    const list = Object.values(rooms)
      .map(r => ({ id: r.id, gameName: r.gameName, playerCount: r.contestants.length }));
    typeof callback === 'function' && callback({ ok: true, rooms: list });
  });

  // ---- 主持人删除房间 ----
  socket.on('delete-room', ({ roomCode }, callback) => {
    try {
      const room = getRoom(roomCode);
      if (!room) return callback?.({ ok: false, error: '房间不存在' });
      // 允许删除条件：是当前主持人，或者房间没有主持人认领（重启后）
      if (room.hostSocketId && socket.id !== room.hostSocketId) return callback?.({ ok: false, error: '你不是该房间的主持人' });
      // 清理该房间所有选手的头像文件
      for (const c of room.contestants) {
        deleteAvatarFile(c.id);
      }
      io.to(roomCode).emit('host-disconnected');
      clearInterval(room.timerInterval);
      deleteRoom(roomCode);
      callback?.({ ok: true });
    } catch (err) {
      callback?.({ ok: false, error: err.message });
    }
  });

  // ---- 创建房间 ----
  socket.on('create-room', ({ gameName }, callback) => {
    try {
      const room = createRoom(gameName || '知识竞赛');
      callback({ ok: true, roomCode: room.id });
    } catch (err) {
      callback({ ok: false, error: err.message });
    }
  });

  // ---- 主持人认领房间 ----
  socket.on('claim-host', ({ roomCode }, callback) => {
    try {
      const room = getRoom(roomCode);
      if (!room) return callback?.({ ok: false, error: '房间不存在' });
      room.hostSocketId = socket.id;
      socket.join(roomCode);
      currentRoom = roomCode;
      callback?.({ ok: true });
    } catch (err) {
      callback?.({ ok: false, error: err.message });
    }
  });

  // ---- 选手重新连接（页面刷新/服务器重启后，用 contestantId 回连） ----
  socket.on('rejoin-room', ({ roomCode, contestantId }, callback) => {
    try {
      const code = roomCode.toUpperCase().trim();
      const room = getRoom(code);
      if (!room) return callback?.({ ok: false, error: '房间不存在' });

      const contestant = room.contestants.find(c => c.id === contestantId);
      if (!contestant) return callback?.({ ok: false, error: '选手不存在，请重新加入' });

      // 更新 Socket 关联
      contestant.socketId = socket.id;
      socket.join(code);
      currentRoom = code;
      currentContestantId = contestant.id;

      // 通知房间选手重新上线（在线状态）
      io.to(code).emit('contestant-status', { contestantId: contestant.id, connected: true });
      io.to(code).emit('contestant-rejoined', { contestantId: contestant.id, name: contestant.name });

      callback?.({ ok: true, room: {
        id: room.id,
        gameName: room.gameName,
        contestants: room.contestants.map(c => ({ id: c.id, name: c.name, score: c.score, color: c.color, avatar: c.avatar || '' })),
        state: room.state,
        currentQuestion: room.currentQuestion,
        currentAnswer: room.currentAnswer,
      }});
    } catch (err) {
      callback?.({ ok: false, error: err.message });
    }
  });

  // ---- 加入房间（同名选手自动重连到已有身份，不重复创建） ----
  socket.on('join-room', ({ roomCode, name }, callback) => {
    try {
      const code = roomCode.toUpperCase().trim();
      const room = getRoom(code);
      if (!room) return callback({ ok: false, error: '房间不存在' });
      if (!name || !name.trim()) return callback({ ok: false, error: '请输入名字' });

      const trimmedName = name.trim().slice(0, 10);

      // 检查是否有同名选手 — 有则直接重连（刷新/重新扫码不丢分数）
      const existing = room.contestants.find(c => c.name === trimmedName);
      if (existing) {
        existing.socketId = socket.id;
        socket.join(code);
        currentRoom = code;
        currentContestantId = existing.id;
        io.to(code).emit('contestant-status', { contestantId: existing.id, connected: true });
        io.to(code).emit('contestant-rejoined', { contestantId: existing.id, name: existing.name });
        io.to(code).emit('score-update', { contestants: room.contestants });
        callback({
          ok: true,
          contestantId: existing.id,
          reconnected: true,
          room: {
            id: room.id,
            gameName: room.gameName,
            contestants: room.contestants,
            state: room.state,
            currentQuestion: room.currentQuestion,
            currentAnswer: room.currentAnswer,
          },
        });
        return;
      }

      if (room.contestants.length >= 8) return callback({ ok: false, error: '房间已满（最多8人）' });

      const contestant = {
        id: generateId(),
        name: trimmedName,
        score: 0,
        color: COLORS[room.contestants.length % COLORS.length],
        avatar: '',
        socketId: socket.id,
      };

      room.contestants.push(contestant);
      socket.join(code);
      currentRoom = code;
      currentContestantId = contestant.id;

      // 通知房间所有人
      io.to(code).emit('contestant-joined', { contestant });
      io.to(code).emit('contestant-status', { contestantId: contestant.id, connected: true });
      io.to(code).emit('score-update', { contestants: room.contestants });
      saveRooms();

      callback({
        ok: true,
        contestantId: contestant.id,
        reconnected: false,
        room: {
          id: room.id,
          gameName: room.gameName,
          contestants: room.contestants,
          state: room.state,
          currentQuestion: room.currentQuestion,
          currentAnswer: room.currentAnswer,
        },
      });
    } catch (err) {
      callback({ ok: false, error: err.message });
    }
  });

  // ---- 主持人开始抢答 ----
  socket.on('start-buzzer', ({ roomCode, timer }, callback) => {
    try {
      const room = getRoom(roomCode);
      if (!room) return callback?.({ ok: false, error: '房间不存在' });
      if (socket.id !== room.hostSocketId) return callback?.({ ok: false, error: '非主持人' });
      if (room.state !== 'idle' && room.state !== 'resolved') return callback?.({ ok: false, error: '当前状态不允许开始' });

      room.state = 'open';
      room.round++;
      room.timerRemaining = timer || 10;
      room.currentBuzzer = null;
      saveRooms();

      // 开始倒计时
      clearInterval(room.timerInterval);
      room.timerInterval = setInterval(() => {
        room.timerRemaining--;
        io.to(roomCode).emit('timer-tick', { remaining: room.timerRemaining });
        if (room.timerRemaining <= 0) {
          clearInterval(room.timerInterval);
          room.timerInterval = null;
          if (room.state === 'open') {
            room.state = 'idle';
            io.to(roomCode).emit('buzzer-state', {
              state: 'idle',
              winner: null,
              remaining: 0,
            });
            saveRooms();
          }
        }
      }, 1000);

      io.to(roomCode).emit('buzzer-state', {
        state: 'open',
        winner: null,
        remaining: room.timerRemaining,
        round: room.round,
      });

      callback?.({ ok: true });
    } catch (err) {
      callback?.({ ok: false, error: err.message });
    }
  });

  // ---- 选手抢答 ----
  socket.on('buzz', ({ roomCode }, callback) => {
    try {
      const room = getRoom(roomCode);
      if (!room) return callback?.({ ok: false, error: '房间不存在' });
      if (room.state !== 'open') return callback?.({ ok: false, error: '当前不可抢答' });

      const contestant = room.contestants.find(c => c.socketId === socket.id);
      if (!contestant) return callback?.({ ok: false, error: '你不是本房间选手' });

      if (room.currentBuzzer) {
        return callback?.({ ok: false, error: '已被抢答' });
      }

      // 抢答成功！
      room.currentBuzzer = {
        contestantId: contestant.id,
        name: contestant.name,
        color: contestant.color,
        timestamp: Date.now(),
      };

      room.buzzHistory.push({
        round: room.round,
        contestantId: contestant.id,
        name: contestant.name,
        timestamp: room.currentBuzzer.timestamp,
      });

      room.state = 'locked';
      clearInterval(room.timerInterval);
      room.timerInterval = null;
      saveRooms();

      io.to(roomCode).emit('buzz-result', {
        winnerId: contestant.id,
        winnerName: contestant.name,
        winnerColor: contestant.color,
      });

      io.to(roomCode).emit('buzzer-state', {
        state: 'locked',
        winner: { id: contestant.id, name: contestant.name, color: contestant.color },
        remaining: room.timerRemaining,
      });

      callback?.({ ok: true });
    } catch (err) {
      callback?.({ ok: false, error: err.message });
    }
  });

  // ---- 主持人判对 ----
  socket.on('judge-correct', ({ roomCode, points }, callback) => {
    try {
      const room = getRoom(roomCode);
      if (!room) return callback?.({ ok: false, error: '房间不存在' });
      if (socket.id !== room.hostSocketId) return callback?.({ ok: false, error: '非主持人' });
      if (room.state !== 'locked') return callback?.({ ok: false, error: '当前状态不可判分' });

      const buzzer = room.currentBuzzer;
      if (!buzzer) return callback?.({ ok: false, error: '无人抢答' });

      const delta = points || 10;
      const contestant = room.contestants.find(c => c.id === buzzer.contestantId);
      if (contestant) {
        contestant.score += delta;
      }

      room.state = 'resolved';
      io.to(roomCode).emit('judge-result', {
        correct: true,
        contestantId: buzzer.contestantId,
        delta,
        newScore: contestant?.score || 0,
        answer: room.currentAnswer || '',
      });
      io.to(roomCode).emit('score-update', { contestants: room.contestants });
      saveRooms();

      callback?.({ ok: true });
    } catch (err) {
      callback?.({ ok: false, error: err.message });
    }
  });

  // ---- 主持人判错 ----
  socket.on('judge-wrong', ({ roomCode, points }, callback) => {
    try {
      const room = getRoom(roomCode);
      if (!room) return callback?.({ ok: false, error: '房间不存在' });
      if (socket.id !== room.hostSocketId) return callback?.({ ok: false, error: '非主持人' });
      if (room.state !== 'locked') return callback?.({ ok: false, error: '当前状态不可判分' });

      const buzzer = room.currentBuzzer;
      if (!buzzer) return callback?.({ ok: false, error: '无人抢答' });

      const delta = points || -5;
      const contestant = room.contestants.find(c => c.id === buzzer.contestantId);
      if (contestant) {
        contestant.score += delta;
      }

      room.state = 'resolved';
      io.to(roomCode).emit('judge-result', {
        correct: false,
        contestantId: buzzer.contestantId,
        delta,
        newScore: contestant?.score || 0,
        answer: room.currentAnswer || '',
      });
      io.to(roomCode).emit('score-update', { contestants: room.contestants });
      saveRooms();

      callback?.({ ok: true });
    } catch (err) {
      callback?.({ ok: false, error: err.message });
    }
  });

  // ---- 下一题 / 重置本轮 ----
  socket.on('next-question', ({ roomCode }, callback) => {
    try {
      const room = getRoom(roomCode);
      if (!room) return callback?.({ ok: false, error: '房间不存在' });
      if (socket.id !== room.hostSocketId) return callback?.({ ok: false, error: '非主持人' });

      room.state = 'idle';
      room.currentBuzzer = null;
      clearInterval(room.timerInterval);
      room.timerInterval = null;
      saveRooms();

      io.to(roomCode).emit('buzzer-state', {
        state: 'idle',
        winner: null,
        remaining: 0,
      });

      callback?.({ ok: true });
    } catch (err) {
      callback?.({ ok: false, error: err.message });
    }
  });

  // ---- 手动调分 ----
  socket.on('adjust-score', ({ roomCode, contestantId, delta }, callback) => {
    try {
      const room = getRoom(roomCode);
      if (!room) return callback?.({ ok: false, error: '房间不存在' });
      if (socket.id !== room.hostSocketId) return callback?.({ ok: false, error: '非主持人' });

      const contestant = room.contestants.find(c => c.id === contestantId);
      if (!contestant) return callback?.({ ok: false, error: '选手不存在' });

      contestant.score += delta;
      io.to(roomCode).emit('score-update', { contestants: room.contestants });
      saveRooms();

      callback?.({ ok: true, newScore: contestant.score });
    } catch (err) {
      callback?.({ ok: false, error: err.message });
    }
  });

  // ---- 主持人移除选手 ----
  socket.on('remove-contestant', ({ roomCode, contestantId }, callback) => {
    try {
      const room = getRoom(roomCode);
      if (!room) return callback?.({ ok: false, error: '房间不存在' });
      if (socket.id !== room.hostSocketId) return callback?.({ ok: false, error: '非主持人' });

      const idx = room.contestants.findIndex(c => c.id === contestantId);
      if (idx === -1) return callback?.({ ok: false, error: '选手不存在' });

      const removed = room.contestants.splice(idx, 1)[0];
      io.to(roomCode).emit('contestant-left', { contestantId: removed.id });
      io.to(roomCode).emit('score-update', { contestants: room.contestants });

      if (room.currentBuzzer && room.currentBuzzer.contestantId === removed.id) {
        room.state = 'idle';
        room.currentBuzzer = null;
        clearInterval(room.timerInterval);
        room.timerInterval = null;
        io.to(roomCode).emit('buzzer-state', { state: 'idle', winner: null, remaining: 0 });
      }
      saveRooms();

      callback?.({ ok: true });
    } catch (err) {
      callback?.({ ok: false, error: err.message });
    }
  });

  // ---- 获取房间信息 ----
  socket.on('get-room', ({ roomCode }, callback) => {
    const room = getRoom(roomCode);
    if (!room) return callback?.({ ok: false, error: '房间不存在' });
    callback({
      ok: true,
      room: {
        id: room.id,
        gameName: room.gameName,
        contestants: room.contestants.map(c => ({ id: c.id, name: c.name, score: c.score, color: c.color, avatar: c.avatar || '', connected: c.socketId !== null })),
        state: room.state,
        timer: room.timer,
        currentBuzzer: room.currentBuzzer,
        round: room.round,
        currentQuestion: room.currentQuestion,
        currentAnswer: room.currentAnswer,
      },
    });
  });

  // ---- 大屏端加入房间（只读监听，不控制状态） ----
  socket.on('join-screen', ({ roomCode }, callback) => {
    try {
      const room = getRoom(roomCode);
      if (!room) return callback?.({ ok: false, error: '房间不存在' });
      socket.join(roomCode);
      currentRoom = roomCode;
      callback({
        ok: true,
        room: {
          id: room.id,
          gameName: room.gameName,
          contestants: room.contestants.map(c => ({
            id: c.id, name: c.name, score: c.score, color: c.color, avatar: c.avatar || '',
            connected: c.socketId !== null,
          })),
          state: room.state,
          timer: room.timer,
          timerRemaining: room.timerRemaining,
          currentBuzzer: room.currentBuzzer,
          round: room.round,
          currentQuestion: room.currentQuestion,
        },
      });
    } catch (err) {
      callback?.({ ok: false, error: err.message });
    }
  });

  // ---- 主持人释放房间（返回房间列表时调用） ----
  socket.on('leave-host', ({ roomCode }, callback) => {
    try {
      const room = getRoom(roomCode);
      if (room && socket.id === room.hostSocketId) {
        room.hostSocketId = null;
      }
      socket.leave(roomCode);
      if (currentRoom === roomCode) currentRoom = null;
      callback?.({ ok: true });
    } catch (err) {
      callback?.({ ok: false, error: err.message });
    }
  });

  // ---- 主持人发布题目 ----
  socket.on('publish-question', ({ roomCode, question, answer, questionId }, callback) => {
    try {
      const room = getRoom(roomCode);
      if (!room) return callback?.({ ok: false, error: '房间不存在' });
      if (socket.id !== room.hostSocketId) return callback?.({ ok: false, error: '非主持人' });

      room.currentQuestion = question || '';
      room.currentAnswer = answer || '';
      room.currentQuestionId = questionId || null;
      // 如果是从题库选用的，记录已出题 ID
      if (questionId && !room.usedQuestionIds.includes(questionId)) {
        room.usedQuestionIds.push(questionId);
        saveRooms();
      }
      // 只广播题目，答案保密——判分时随 judge-result 公布
      io.to(roomCode).emit('question-update', { question: room.currentQuestion });
      callback?.({ ok: true, answer: room.currentAnswer });
    } catch (err) {
      callback?.({ ok: false, error: err.message });
    }
  });

  // ---- 题库管理（需要密码验证） ----
  function checkPassword(password) {
    const pw = (password || '').trim();
    return pw === config.adminPassword;
  }

  function getRoomQuestions(roomCode) {
    if (!questionBank[roomCode]) questionBank[roomCode] = [];
    return questionBank[roomCode];
  }

  socket.on('get-questions', ({ roomCode, password }, callback) => {
    try {
      if (!checkPassword(password)) return callback?.({ ok: false, error: '密码错误' });
      const questions = getRoomQuestions(roomCode);
      const room = getRoom(roomCode);
      callback?.({ ok: true, questions, usedQuestionIds: room?.usedQuestionIds || [] });
    } catch (err) {
      callback?.({ ok: false, error: err.message });
    }
  });

  socket.on('add-question', ({ roomCode, password, question, answer }, callback) => {
    try {
      if (!checkPassword(password)) return callback?.({ ok: false, error: '密码错误' });
      const list = getRoomQuestions(roomCode);
      list.push({ id: genQId(), question, answer, createdAt: Date.now() });
      saveQuestions();
      callback?.({ ok: true, questions: list });
    } catch (err) {
      callback?.({ ok: false, error: err.message });
    }
  });

  socket.on('update-question', ({ roomCode, password, id, question, answer }, callback) => {
    try {
      if (!checkPassword(password)) return callback?.({ ok: false, error: '密码错误' });
      const list = getRoomQuestions(roomCode);
      const q = list.find(item => item.id === id);
      if (!q) return callback?.({ ok: false, error: '题目不存在' });
      q.question = question;
      q.answer = answer;
      saveQuestions();
      callback?.({ ok: true, questions: list });
    } catch (err) {
      callback?.({ ok: false, error: err.message });
    }
  });

  socket.on('delete-question', ({ roomCode, password, id }, callback) => {
    try {
      if (!checkPassword(password)) return callback?.({ ok: false, error: '密码错误' });
      const list = getRoomQuestions(roomCode);
      const idx = list.findIndex(item => item.id === id);
      if (idx === -1) return callback?.({ ok: false, error: '题目不存在' });
      list.splice(idx, 1);
      saveQuestions();
      callback?.({ ok: true, questions: list });
    } catch (err) {
      callback?.({ ok: false, error: err.message });
    }
  });
  socket.on('import-csv', ({ roomCode, password, csv }, callback) => {
    try {
      if (!checkPassword(password)) return callback?.({ ok: false, error: '密码错误' });
      const list = getRoomQuestions(roomCode);
      const lines = (csv || '').split('\n').filter(l => l.trim());
      let imported = 0;
      for (const line of lines) {
        const parts = line.split(',').map(s => s.trim());
        if (parts.length >= 2 && parts[0]) {
          list.push({ id: genQId(), question: parts[0], answer: parts[1] || '', createdAt: Date.now() });
          imported++;
        }
      }
      if (imported > 0) saveQuestions();
      callback?.({ ok: true, imported, total: list.length, questions: list });
    } catch (err) {
      callback?.({ ok: false, error: err.message });
    }
  });

  // ---- 断开连接 ----
  socket.on('disconnect', () => {
    if (currentRoom) {
      const room = getRoom(currentRoom);
      if (room) {
        if (socket.id === room.hostSocketId) {
          // 主持人断开，清除主持权，但不删除房间
          io.to(currentRoom).emit('host-disconnected');
          clearInterval(room.timerInterval);
          room.hostSocketId = null;
          room.state = 'idle';
          room.currentBuzzer = null;
          room.timerInterval = null;
          saveRooms();
          return;
        }

        // 选手断开 — 通知 host 更新连接状态
        if (currentContestantId) {
          // 清除 socketId，使 get-room 能准确判断离线
          // 只清除当 socketId 仍指向本 socket 的情况（防止新连接覆盖后被错误清空）
          const contestant = room.contestants.find(c => c.id === currentContestantId && c.socketId === socket.id);
          if (contestant) {
            contestant.socketId = null;
          }
          io.to(currentRoom).emit('contestant-status', { contestantId: currentContestantId, connected: false });
          // 如果正在抢答，重置
          if (room.currentBuzzer && room.currentBuzzer.contestantId === currentContestantId) {
            room.state = 'idle';
            room.currentBuzzer = null;
            clearInterval(room.timerInterval);
            room.timerInterval = null;
            io.to(currentRoom).emit('buzzer-state', { state: 'idle', winner: null, remaining: 0 });
            saveRooms();
          }
        }
      }
    }
  });
});

// ======== 启动 ========
loadRooms();
loadQuestions();
cleanupOldRooms();

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎯 抢答系统已启动！`);
  console.log(`   本地访问: http://localhost:${PORT}`);
  console.log(`   局域网访问: http://<本机IP>:${PORT}`);
  console.log(`   数据文件: rooms-data.json`);
  console.log(`   按 Ctrl+C 停止`);
});
