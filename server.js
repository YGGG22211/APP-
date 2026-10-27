'use strict';
/**
 * 智学服务器 · 共享业务入口（PC / 手机端通用）
 * 零第三方依赖：Node 内置 http + fetch（Node 18+）。
 * 环境变量：SERVER_MODE=pc|phone，PORT，DATA_DIR，AI_KEY_SECRET
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { uid, token, genUid, ok, fail, readBody, log } = require('./util');
const crypto = require('crypto');
const AI = require('./ai');
const Actions = require('./actions');
const { sm2Update } = require('./sm2');
const Security = require('./security');

const MODE = process.env.SERVER_MODE || 'pc';
const PORT = Number(process.env.PORT || (MODE === 'phone' ? 8788 : 8787));
// 公网地址（隧道 / 云服务器场景）：App 据此自动把连接地址切换到公网，
// 例如 HOST=0.0.0.0 PUBLIC_URL=https://zhixue.trycloudflare.com node src/server.js
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const RELEASE_DIR = __dirname;

store.init();
const db = store.get();

/* ==================== 预置：学习助手（可编辑不可删除） ==================== */
function ensurePreset() {
  // 逐用户在注册时创建（ownerId 隔离）
}

/* ==================== 鉴权 ==================== */
function authUser(req) {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  const s = db.sessions[t];
  if (!s) return null;
  // 会话过期则作废（防长期有效的被盗 token 滥用）
  if (s.expiresAt && s.expiresAt < Date.now()) {
    delete db.sessions[t];
    try { store.save(); } catch (_) {}
    return null;
  }
  return db.users.find(u => u.id === s.userId) || null;
}

// 定期清理过期会话（每小时一次），降低内存与令牌泄露面
const _sessionCleanup = setInterval(() => {
  try {
    const now = Date.now();
    let changed = false;
    for (const k of Object.keys(db.sessions)) {
      const s = db.sessions[k];
      if (s.expiresAt && s.expiresAt < now) { delete db.sessions[k]; changed = true; }
    }
    if (changed) store.save();
  } catch (_) {}
}, 3600 * 1000);
if (typeof _sessionCleanup.unref === 'function') _sessionCleanup.unref();

function publicUser(u) {
  return { id: u.id, email: u.email, uid: u.uid, shortId: u.shortId, nickname: u.nickname,
    bio: u.bio, gender: u.gender, orientation: u.orientation, avatar: u.avatar || '🫧', tags: u.tags || [],
    city: u.city || '', school: u.school || '', createdAt: u.createdAt };
}

// ===== 成长体系：积分 / 等级 / 签到 =====
function levelOf(points) {
  const lv = [0, 50, 120, 220, 360, 550, 800, 1200, 1800, 2600, 3600]; // 每级门槛（递增）
  let level = 1;
  for (let i = 0; i < lv.length; i++) if (points >= lv[i]) level = i + 1;
  const cur = lv[level - 1] || 0;
  const next = lv[level] != null ? lv[level] : null;
  return { level, cur, next, name: 'Lv.' + level };
}
function awardPoints(u, n) { u.points = (u.points || 0) + n; store.save(); }
// 生成一条「互动通知」（点赞 / 好友申请 / @提醒），不通知自己
function pushNotif(targetId, payload) {
  if (!db.notifications) db.notifications = [];
  if (targetId) db.notifications.push({
    id: uid(), userId: targetId, type: payload.type || 'msg',
    title: payload.title, body: payload.body, sender: payload.sender || '智学',
    icon: payload.icon || '🔔', readBy: [], createdAt: new Date().toISOString(),
  });
  store.save();
}

async function sendCode(req, res, _user, body) {
  const email = String(body.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail(res, 1001, '邮箱格式不正确');
  const purpose = body.purpose === 'reset' ? 'reset' : 'register';
  // 重置密码：该邮箱必须已注册；注册：该邮箱必须未注册
  if (purpose === 'reset' && !db.users.some(u => u.email === email)) return fail(res, 2004, '该邮箱尚未注册，请先注册账号');
  if (purpose === 'register' && db.users.some(u => u.email === email)) return fail(res, 1005, '该邮箱已注册，请直接登录');
  const code = String(crypto.randomInt(100000, 999999));
  db.codes[email] = { code, purpose, expiresAt: Date.now() + 10 * 60 * 1000 };
  store.save();
  // 真实 SMTP 发送；发送失败时回退为直接展示（便于离线调试）
  let sent = false, smtpError = null;
  try {
    const mail = require('./mail');
    await mail.sendCode(email, code, purpose);
    sent = true;
    log(`[auth] ${purpose === 'reset' ? '重置密码' : '注册'}验证码已发送至 ${email}`);
  } catch (e) {
    smtpError = e.message;
    log(`[auth] 邮件发送失败，回退展示：${e.message}`);
  }
  ok(res, { sent, devCode: sent ? undefined : code,
    note: sent ? `验证码已发送至 ${email}，请查收（含垃圾箱）` : `邮件发送失败（${smtpError}），此处直接展示验证码` });
}

async function register(req, res, _user, body) {
  const email = String(body.email || '').trim().toLowerCase();
  const code = String(body.code || '');
  const password = String(body.password || '');
  const rec = db.codes[email];
  if (!rec || rec.expiresAt < Date.now()) return fail(res, 1002, '验证码已过期，请重新获取');
  if (rec.code !== code) return fail(res, 1003, '验证码错误');
  if (password.length < 6) return fail(res, 1004, '密码至少 6 位');
  if (db.users.some(u => u.email === email)) return fail(res, 1005, '该邮箱已注册，请直接登录');
  const salt = crypto.randomBytes(16).toString('hex');
  const u = {
    id: uid(), email, salt,
    pwdHash: crypto.scryptSync(password, salt, 32).toString('hex'),
    uid: genUid(db),
    shortId: null,
    nickname: '玻璃用户' + crypto.randomInt(1000, 9999),
    bio: '', gender: '保密', orientation: '保密',
    avatar: '🫧', tags: [], // 头像 emoji + 兴趣标签（发现页展示）
    hideFromDiscover: false, // 隐私：true 时不在「发现好友」中展示，别人找不到我
    city: '', school: '',     // 城市 / 学校（附近的人、匹配用）
    points: 0,                // 成长积分
    checkin: { streak: 0, last: null, total: 0 }, // 连续签到 / 最近签到日 / 累计
    createdAt: new Date().toISOString(),
  };
  db.users.push(u);
  delete db.codes[email];
  // 首个注册用户自动成为管理员
  if (db.users.length === 1) { db.admins.push(u.id); log(`[auth] 首个用户 ${email} 自动成为管理员`); }
  // 预置「学习助手」AI 会话与智能体（可编辑不可删除）
  const agent = { id: uid(), ownerId: u.id, name: '学习助手', avatar: '助', persona: '耐心、鼓励式教学，擅长拆解知识点', gender: '女', style: '温和清晰', providerId: null, system: true };
  db.agents.push(agent);
  db.chats.push({ id: uid(), ownerId: u.id, type: 'ai', peerId: agent.id, title: agent.name, avatar: agent.avatar, createdAt: new Date().toISOString() });
  db.chats.push({ id: uid(), ownerId: u.id, type: 'friend', peerId: 'filehelper', title: '文件传输助手', avatar: '传', createdAt: new Date().toISOString() });
  const t = token();
  db.sessions[t] = { userId: u.id, createdAt: new Date().toISOString(), expiresAt: Date.now() + Security.SESSION_TTL };
  store.saveNow();
  log(`[auth] 注册成功 ${email} UID=${u.uid}`);
  ok(res, { token: t, user: publicUser(u) });
}

async function login(req, res, _user, body) {
  const email = String(body.email || '').trim().toLowerCase();
  const u = db.users.find(x => x.email === email);
  if (!u) { logLogin(null, email, false, req); return fail(res, 2001, '账号不存在'); }
  const hash = crypto.scryptSync(String(body.password || ''), u.salt, 32).toString('hex');
  if (hash !== u.pwdHash) { logLogin(u.id, email, false, req); return fail(res, 2002, '密码错误'); }
  if (u.banned) { logLogin(u.id, email, false, req); return fail(res, 2005, '账号已被管理员禁用，请联系管理员'); }
  const t = token();
  db.sessions[t] = { userId: u.id, createdAt: new Date().toISOString(), expiresAt: Date.now() + Security.SESSION_TTL };
  u.lastLoginAt = new Date().toISOString();
  logLogin(u.id, email, true, req);
  store.save();
  log(`[auth] 登录成功 ${email}`);
  ok(res, { token: t, user: publicUser(u), isAdmin: db.admins.includes(u.id) });
}

/// 登录审计（保留最近 500 条）
function logLogin(userId, email, okFlag, req) {
  db.loginLogs.unshift({ userId, email, ok: !!okFlag,
    ip: (req.socket && req.socket.remoteAddress) || '', ua: String(req.headers['user-agent'] || '').slice(0, 120),
    createdAt: new Date().toISOString() });
  if (db.loginLogs.length > 500) db.loginLogs.length = 500;
}

/// 忘记密码：邮箱 + 验证码（purpose=reset）+ 新密码
async function resetPassword(req, res, _user, body) {
  const email = String(body.email || '').trim().toLowerCase();
  const code = String(body.code || '');
  const password = String(body.password || '');
  const rec = db.codes[email];
  if (!rec || rec.expiresAt < Date.now()) return fail(res, 1002, '验证码已过期，请重新获取');
  if (rec.code !== code) return fail(res, 1003, '验证码错误');
  if (rec.purpose !== 'reset') return fail(res, 1006, '该验证码不是重置密码专用，请重新获取');
  if (password.length < 6) return fail(res, 1004, '密码至少 6 位');
  const u = db.users.find(x => x.email === email);
  if (!u) return fail(res, 2001, '账号不存在');
  const salt = crypto.randomBytes(16).toString('hex');
  u.salt = salt;
  u.pwdHash = crypto.scryptSync(password, salt, 32).toString('hex');
  delete db.codes[email];
  // 重置密码后吊销该用户全部旧会话（安全）
  for (const t of Object.keys(db.sessions)) {
    if (db.sessions[t].userId === u.id) delete db.sessions[t];
  }
  store.saveNow();
  log(`[auth] 重置密码成功 ${email}，旧会话已全部吊销`);
  ok(res, { note: '密码已重置，请使用新密码登录' });
}

/* ==================== AI：厂商配置 ==================== */
async function createProvider(req, res, user, body) {
  const vendor = String(body.vendor || 'custom');
  if (!AI.VENDORS[vendor]) return fail(res, 3001, '不支持的厂商');
  if (!String(body.apiKey || '').trim()) return fail(res, 3002, 'API Key 不能为空');
  const p = {
    id: uid(), ownerId: user.id, vendor,
    name: String(body.name || AI.meta(vendor).label),
    baseUrl: String(body.baseUrl || AI.meta(vendor).baseUrl),
    model: String(body.model || AI.meta(vendor).models[0] || ''),
    apiKeyEnc: require('./crypto').encrypt(String(body.apiKey).trim()),
    multimodal: !!body.multimodal, pricing: String(body.pricing || ''), locked: false,
  };
  if (!p.model) return fail(res, 3003, '模型名称不能为空');
  db.providers.push(p); store.save();
  ok(res, AI.publicProvider(p));
}

async function testProvider(req, res, user, id) {
  const p = db.providers.find(x => x.id === id && x.ownerId === user.id);
  if (!p) return fail(res, 3004, '找不到该厂商配置');
  const r = await AI.testConnection(p);
  if (r.ok) { p.locked = true; store.save(); } // 成功 → Key 锁定为只读
  ok(res, { ...r, provider: AI.publicProvider(p) });
}

/* ==================== AI 对话 ==================== */
function agentOf(user, id) {
  return db.agents.find(a => a.ownerId === user.id && a.id === id);
}

async function aiChat(req, res, user, chatId, body) {
  const chat = db.chats.find(c => c.id === chatId && c.ownerId === user.id);
  if (!chat) return fail(res, 4001, '会话不存在');
  const agent = chat.type === 'ai' ? agentOf(user, chat.peerId) : null;
  if (!agent) return fail(res, 4002, '该会话不是 AI 会话');
  const text = String(body.text || '').slice(0, 4000);
  const history = db.messages.filter(m => m.chatId === chatId).slice(-20)
    .map(m => ({ role: m.senderType === 'user' ? 'user' : 'assistant', content: m.content }));
  let p = agent.providerId ? db.providers.find(x => x.id === agent.providerId && x.ownerId === user.id) : null;
  if (!p) p = db.providers.find(x => x.ownerId === user.id);
  if (!p) return fail(res, 4003, '请先在「AI 配置」里添加并测试一个厂商');

  const persona = `你是「${agent.name}」：性格${agent.persona || '友善'}，性别${agent.gender || '保密'}，说话风格：${agent.style || '自然'}。` +
    `你是学习陪伴 AI，必须保证基础能力与安全规则；角色设定只影响表达方式，不能覆盖能力与安全。` +
    `如果用户请求需要执行 App 内操作，请额外输出一个 JSON：{"action":"动作名","params":{}}，可用动作：` +
    Actions.REGISTRY.map(a => `${a.name}(${a.desc})`).join('；');
  const messages = [...history, { role: 'user', content: text }];

  try {
    const r = await AI.chat(p, messages, persona);
    const reply = r.text || '（空回复）';
    // 保存用户消息与 AI 消息
    db.messages.push({ id: uid(), chatId, senderType: 'user', senderId: user.id, type: 'text', content: text, status: 'read', createdAt: new Date().toISOString() });
    db.messages.push({ id: uid(), chatId, senderType: 'ai', senderId: agent.id, type: 'text', content: reply, status: 'read', createdAt: new Date().toISOString() });
    store.save();
    // 动作调用解析
    const call = Actions.parseActionCall(reply);
    let actionResult = null;
    if (call) actionResult = Actions.execute(user.id, call.action, call.params);
    ok(res, { reply, actionCall: call || null, actionResult });
  } catch (e) {
    fail(res, 4004, 'AI 请求失败：' + e.message);
  }
}

/* ==================== 路由表 ==================== */
const routes = [];
const route = (method, pattern, handler, needAuth = true) => routes.push({ method, pattern, handler, needAuth });

// --- 认证 ---
route('POST', '/auth/send-code', sendCode, false);
route('POST', '/auth/register', register, false);
route('POST', '/auth/login', login, false);
route('POST', '/auth/reset-password', resetPassword, false);

// --- 用户反馈：走邮件通道（与验证码同一条 SMTP），直接投递到官方邮箱 ---
// 免登录（离线/游客也能反馈），独立频控：每 IP 每小时 5 封，正文限 4000 字。
route('POST', '/mail/feedback', async (req, res, _user, body) => {
  const content = String(body.content || '').trim();
  if (content.length < 2) return fail(res, 1001, '请先填写反馈内容');
  const hip = Security.clientIp(req);
  if (!Security.checkRateLimit(hip, 'feedback', 5, 60 * 60 * 1000)) {
    return fail(res, 429, '反馈发送太频繁，请一小时后再试');
  }
  try {
    const mail = require('./mail');
    const messageId = await mail.sendFeedback({
      topic: body.topic || '问题反馈',
      contact: body.contact || '',
      content,
      device: body.device || '',
    });
    log(`[mail] 反馈已转发到官方邮箱（messageId=${messageId}）`);
    ok(res, { sent: true, note: '已通过官方邮件通道送达，我们会尽快回复' });
  } catch (e) {
    log('[mail] 反馈发送失败：', e.message);
    // 降级：返回明确错误，App 端会回落到「跳转邮箱 App」的老路子
    fail(res, 5002, '邮件通道暂不可用（' + (e.message || '未知错误') + '），请改用邮箱发送');
  }
}, false);
route('GET', '/me', (req, res, u) => ok(res, Object.assign(publicUser(u), {
  isAdmin: db.admins.includes(u.id),
  hideFromDiscover: !!u.hideFromDiscover,
  points: u.points || 0,
  level: levelOf(u.points || 0),
  checkin: u.checkin || { streak: 0, last: null, total: 0 },
})));

// 隐私设置：隐藏登录/在线状态，不在「发现好友」中展示（别人无法找到我）
route('POST', '/me/privacy', (req, res, u, b) => {
  if (b && typeof b.hideFromDiscover === 'boolean') u.hideFromDiscover = b.hideFromDiscover;
  store.save();
  ok(res, { hideFromDiscover: !!u.hideFromDiscover });
});

route('PUT', '/me/profile', (req, res, u, b) => {
  for (const k of ['nickname', 'bio', 'gender', 'orientation']) if (k in b) u[k] = String(b[k]).slice(0, 100);
  if ('city' in b) u.city = String(b.city || '').trim().slice(0, 20);
  if ('school' in b) u.school = String(b.school || '').trim().slice(0, 40);
  if ('avatar' in b) u.avatar = String(b.avatar || '🫧').slice(0, 8);
  if ('tags' in b && Array.isArray(b.tags)) u.tags = b.tags.map(String).slice(0, 6);
  store.save(); ok(res, publicUser(u));
});
route('PUT', '/me/short-id', (req, res, u, b) => {
  const sid = String(b.shortId || '').trim();
  if (!sid || sid.length > 20) return fail(res, 5001, '短 ID 需 1-20 个字符');
  if (db.users.some(x => x.shortId === sid && x.id !== u.id)) return fail(res, 5002, '短 ID 已被占用');
  u.shortId = sid; store.save(); ok(res, publicUser(u));
});

// --- 好友 ---
route('POST', '/friends/search', (req, res, u, b) => {
  const q = String(b.query || '').trim();
  const hit = db.users.find(x => x.uid === q || (x.shortId && x.shortId === q));
  if (!hit) return fail(res, 6001, '没有找到该 UID / 短 ID 对应的用户');
  ok(res, { user: publicUser(hit), isSelf: hit.id === u.id });
});
route('POST', '/friends/request', (req, res, u, b) => {
  const peer = db.users.find(x => x.id === b.userId);
  if (!peer) return fail(res, 6002, '目标用户不存在');
  if (db.friends.some(f => (f.a === u.id && f.b === peer.id) || (f.a === peer.id && f.b === u.id)))
    return fail(res, 6003, '好友关系已存在或待处理');
  const f = { id: uid(), a: u.id, b: peer.id, status: 'pending', requester: u.id, createdAt: new Date().toISOString() };
  db.friends.push(f); store.save();
  // 好友申请通知对方
  pushNotif(peer.id, { type: 'friend', icon: '🤝', title: '收到好友申请',
    body: `${u.nickname} 想加你为好友`, sender: u.nickname });
  ok(res, { requestId: f.id });
});
route('GET', '/friends/requests', (req, res, u) => {
  const list = db.friends.filter(f => (f.b === u.id || f.a === u.id) && f.status === 'pending')
    .map(f => ({ id: f.id, incoming: f.b === u.id, from: publicUser(db.users.find(x => x.id === f.a)) }));
  ok(res, list);
});
route('POST', '/friends/accept', (req, res, u, b) => {
  const f = db.friends.find(x => x.id === b.requestId && x.b === u.id);
  if (!f) return fail(res, 6004, '请求不存在');
  f.status = 'accepted'; store.save();
  awardPoints(u, 3); // 通过好友申请 +3 分
  const peer = db.users.find(x => x.id === f.a);
  if (peer) awardPoints(peer, 3); // 对方也 +3 分
  ok(res, { accepted: true });
});
route('GET', '/friends', (req, res, u) => {
  const list = db.friends.filter(f => f.status === 'accepted' && (f.a === u.id || f.b === u.id))
    .map(f => publicUser(db.users.find(x => x.id === (f.a === u.id ? f.b : f.a))));
  ok(res, list);
});

// --- 发现 / 推荐好友（脱敏，排除自己 / 已加好友 / 已拉黑 / 被禁用）---
route('GET', '/friends/discover', (req, res, u, _b, q) => {
  if (!db.blocks) db.blocks = [];
  const me = u.id;
  const blocked = new Set(db.blocks.filter(x => x.a === me).map(x => x.b));          // 我拉黑的
  const myFriends = new Set(db.friends
    .filter(f => (f.a === me || f.b === me) && f.status === 'accepted')
    .map(f => (f.a === me ? f.b : f.a)));
  const kw = String(q.q || '').trim().toLowerCase();
  const list = db.users
    .filter(x => x.id !== me && !blocked.has(x.id) && !myFriends.has(x.id) && !x.banned && !x.hideFromDiscover)
    .filter(x => !kw
      || (x.nickname || '').toLowerCase().includes(kw)
      || (x.uid || '').includes(kw)
      || (x.shortId || '').toLowerCase().includes(kw))
    .slice(0, 50)
    .map(x => ({ id: x.id, uid: x.uid, shortId: x.shortId, nickname: x.nickname, bio: x.bio, gender: x.gender,
      avatar: x.avatar || '🫧', tags: x.tags || [] }));
  ok(res, list);
});

// --- 拉黑 / 解除拉黑 ---
route('POST', '/friends/block', (req, res, u, b) => {
  if (!db.blocks) db.blocks = [];
  const peer = db.users.find(x => x.id === b.userId);
  if (!peer) return fail(res, 6002, '目标用户不存在');
  if (peer.id === u.id) return fail(res, 6005, '不能拉黑自己');
  if (!db.blocks.some(x => x.a === u.id && x.b === peer.id))
    db.blocks.push({ id: uid(), a: u.id, b: peer.id, createdAt: new Date().toISOString() });
  // 同时解除好友关系（若有），避免还能看到/私聊
  db.friends = db.friends.filter(f => !((f.a === u.id && f.b === peer.id) || (f.a === peer.id && f.b === u.id)));
  store.save(); ok(res, { blocked: true });
});
route('POST', '/friends/unblock', (req, res, u, b) => {
  if (!db.blocks) db.blocks = [];
  db.blocks = db.blocks.filter(x => !(x.a === u.id && x.b === b.userId));
  store.save(); ok(res, { unblocked: true });
});

// --- 朋友圈 / 动态（服务器持久化，支持点赞与评论）---
const _momentOut = (m, u) => {
  const author = db.users.find(x => x.id === m.userId);
  return {
    id: m.id, text: m.text, images: m.images || [], tags: m.tags || [],
    createdAt: m.createdAt,
    author: author ? { uid: author.uid, nickname: author.nickname, avatar: author.avatar || '🫧' } : { uid: '', nickname: '用户', avatar: '🫧' },
    likeCount: (m.likes || []).length,
    liked: (m.likes || []).includes(u.id),
    comments: (m.comments || []).map(c => ({ id: c.id, name: c.name, text: c.text, createdAt: c.createdAt })),
  };
};
route('GET', '/moments', (req, res, u, _b, q) => {
  if (!db.moments) db.moments = [];
  let list = db.moments.slice();
  const tag = String(q.tag || '').trim();
  if (tag) list = list.filter(m => (m.tags || []).includes(tag));
  list.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  const out = list.map(m => _momentOut(m, u));
  ok(res, out.slice(0, 100));
});

route('POST', '/moments', (req, res, u, b) => {
  if (!db.moments) db.moments = [];
  const text = String(b.text || '').trim().slice(0, 1000);
  if (!text) return fail(res, 7001, '动态内容不能为空');
  const m = {
    id: uid(), userId: u.id, text,
    images: Array.isArray(b.images) ? b.images.slice(0, 9).map(String) : [],
    tags: Array.isArray(b.tags) ? b.tags.slice(0, 6).map(String) : [],
    createdAt: new Date().toISOString(),
    likes: [], comments: [],
  };
  db.moments.push(m); store.save();
  awardPoints(u, 2); // 发动态 +2 分
  ok(res, { id: m.id, createdAt: m.createdAt, points: u.points });
});

route('DELETE', '/moments/:id', (req, res, u) => {
  if (!db.moments) db.moments = [];
  const m = db.moments.find(x => x.id === req.params.id);
  if (!m) return fail(res, 7004, '动态不存在');
  if (m.userId !== u.id) return fail(res, 7005, '只能删除自己的动态');
  db.moments = db.moments.filter(x => x.id !== req.params.id);
  store.save(); ok(res, { deleted: true });
});

route('POST', '/moments/:id/like', (req, res, u) => {
  if (!db.moments) db.moments = [];
  const m = db.moments.find(x => x.id === req.params.id);
  if (!m) return fail(res, 7004, '动态不存在');
  m.likes = m.likes || [];
  const i = m.likes.indexOf(u.id);
  let liked = false;
  if (i >= 0) m.likes.splice(i, 1); else { m.likes.push(u.id); liked = true; }
  store.save();
  // 点赞通知（不通知自己）
  if (liked && m.userId !== u.id) {
    const owner = db.users.find(x => x.id === m.userId);
    pushNotif(m.userId, { type: 'like', icon: '❤️', title: '有人赞了你的动态',
      body: `${u.nickname} 赞了：${(m.text || '').slice(0, 30)}`, sender: u.nickname });
  }
  ok(res, { liked, likeCount: m.likes.length });
});

route('POST', '/moments/:id/comment', (req, res, u, b) => {
  if (!db.moments) db.moments = [];
  const m = db.moments.find(x => x.id === req.params.id);
  if (!m) return fail(res, 7004, '动态不存在');
  const text = String(b.text || '').trim().slice(0, 500);
  if (!text) return fail(res, 7006, '评论不能为空');
  const author = db.users.find(x => x.id === u.id);
  const c = { id: uid(), userId: u.id, name: author ? author.nickname : '用户', text, createdAt: new Date().toISOString() };
  m.comments = m.comments || [];
  m.comments.push(c); store.save();
  awardPoints(u, 1); // 评论 +1 分
  // 评论通知动态作者（不通知自己）
  if (m.userId !== u.id) {
    pushNotif(m.userId, { type: 'comment', icon: '💬', title: '有人评论了你的动态',
      body: `${u.nickname}：${text.slice(0, 30)}`, sender: u.nickname });
  }
  // @提醒：解析 @UID（如 @1000002026）通知被提及者
  const at = text.match(/@(\d{6,})/g) || [];
  for (const token of at) {
    const uidNum = token.slice(1);
    const mentioned = db.users.find(x => String(x.uid) === uidNum);
    if (mentioned && mentioned.id !== u.id) {
      pushNotif(mentioned.id, { type: 'mention', icon: '📣', title: `${u.nickname} 在评论里 @ 了你`,
        body: text.slice(0, 30), sender: u.nickname });
    }
  }
  ok(res, { id: c.id });
});

// ===== 成长体系：每日签到 =====
route('POST', '/checkin', (req, res, u) => {
  const c = u.checkin || (u.checkin = { streak: 0, last: null, total: 0 });
  const today = new Date().toISOString().slice(0, 10);
  if (c.last === today) return fail(res, 7101, '今天已经签到过了');
  // 连续签到：昨天签过则 +1，否则重置为 1
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  c.streak = c.last === yesterday ? c.streak + 1 : 1;
  c.last = today;
  c.total = (c.total || 0) + 1;
  const bonus = c.streak >= 7 ? 10 : c.streak >= 3 ? 8 : 5; // 连签 3/7 天额外奖励
  awardPoints(u, bonus);
  store.save();
  ok(res, { streak: c.streak, total: c.total, gained: bonus, points: u.points, level: levelOf(u.points) });
});

// ===== 成长体系：本地数据上云（游客期攒的积分/签到，登录后合并到账号）=====
// 合并规则：签到取「更长的连续/更大的累计」，积分取「更大的值」，不会让用户吃亏
route('POST', '/growth/merge', (req, res, u, b) => {
  const inPoints = Number(b && b.points) || 0;
  const inCheckin = (b && b.checkin && typeof b.checkin === 'object') ? b.checkin : {};
  const c = u.checkin || (u.checkin = { streak: 0, last: null, total: 0 });
  const changed = {};
  if (inPoints > (u.points || 0)) { u.points = inPoints; changed.points = true; }
  const sIn = Number(inCheckin.streak) || 0;
  const tIn = Number(inCheckin.total) || 0;
  if (sIn > (c.streak || 0)) { c.streak = sIn; changed.streak = true; }
  if (tIn > (c.total || 0)) { c.total = tIn; changed.total = true; }
  const lastIn = inCheckin.last ? String(inCheckin.last) : null;
  if (lastIn && (!c.last || lastIn > c.last)) { c.last = lastIn; changed.last = true; }
  store.save();
  ok(res, { points: u.points || 0, level: levelOf(u.points || 0), checkin: c, changed });
});

// ===== 成长体系：榜单 =====
route('GET', '/leaderboard', (req, res, u, _b, q) => {
  const type = String(q.type || 'points');
  let ranked = db.users.filter(x => !x.banned).map(x => ({ uid: x.uid, nickname: x.nickname, avatar: x.avatar || '🫧',
    points: x.points || 0,
    moments: (db.moments || []).filter(m => m.userId === x.id).length,
    friends: (db.friends || []).filter(f => (f.a === x.id || f.b === x.id) && f.status === 'accepted').length,
  }));
  if (type === 'moments') ranked.sort((a, b) => b.moments - a.moments);
  else if (type === 'friends') ranked.sort((a, b) => b.friends - a.friends);
  else ranked.sort((a, b) => b.points - a.points);
  ranked = ranked.slice(0, 30).map((x, i) => ({ rank: i + 1, ...x }));
  ok(res, { type, list: ranked });
});

// ===== 内容发现：热门动态 / 附近的人 =====
route('GET', '/moments/hot', (req, res, u) => {
  if (!db.moments) db.moments = [];
  const list = db.moments.slice()
    .map(m => ({ m, score: (m.likes || []).length * 3 + (m.comments || []).length * 2 + 1 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 30)
    .map(x => _momentOut(x.m, u));
  ok(res, list);
});

route('GET', '/friends/nearby', (req, res, u) => {
  if (!db.blocks) db.blocks = [];
  const me = u.id;
  const blocked = new Set(db.blocks.filter(x => x.a === me).map(x => x.b));
  const myFriends = new Set(db.friends.filter(f => (f.a === me || f.b === me) && f.status === 'accepted').map(f => (f.a === me ? f.b : f.a)));
  const myCity = (u.city || '').trim(), mySchool = (u.school || '').trim();
  const list = db.users
    .filter(x => x.id !== me && !blocked.has(x.id) && !myFriends.has(x.id) && !x.banned && !x.hideFromDiscover)
    .filter(x => (myCity && (x.city || '').trim() === myCity) || (mySchool && (x.school || '').trim() === mySchool))
    .slice(0, 50)
    .map(x => ({ id: x.id, uid: x.uid, shortId: x.shortId, nickname: x.nickname, bio: x.bio, gender: x.gender,
      avatar: x.avatar || '🫧', tags: x.tags || [], city: x.city || '', school: x.school || '',
      sameCity: !!(myCity && (x.city || '').trim() === myCity), sameSchool: !!(mySchool && (x.school || '').trim() === mySchool) }));
  ok(res, list);
});

// ===== 社交增强：圈子 / 群聊 =====
route('POST', '/groups', (req, res, u, b) => {
  if (!db.groups) db.groups = [];
  const name = String(b.name || '').trim().slice(0, 30);
  if (!name) return fail(res, 7201, '圈子名称不能为空');
  const g = { id: uid(), name, desc: String(b.desc || '').slice(0, 200), ownerId: u.id,
    members: [u.id], createdAt: new Date().toISOString() };
  db.groups.push(g); store.save();
  awardPoints(u, 5); // 创建圈子 +5 分
  ok(res, { id: g.id });
});
route('POST', '/groups/:id/join', (req, res, u) => {
  if (!db.groups) db.groups = [];
  const g = db.groups.find(x => x.id === req.params.id);
  if (!g) return fail(res, 7202, '圈子不存在');
  if (!g.members.includes(u.id)) { g.members.push(u.id); store.save(); awardPoints(u, 2); }
  ok(res, { joined: true, memberCount: g.members.length });
});
route('GET', '/groups/mine', (req, res, u) => {
  if (!db.groups) db.groups = [];
  const list = db.groups.filter(g => g.members.includes(u.id))
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    .map(g => ({ id: g.id, name: g.name, desc: g.desc, ownerId: g.ownerId,
      memberCount: g.members.length, momentsCount: (g.moments || []).length,
      owner: (db.users.find(x => x.id === g.ownerId) || {}).nickname || '' }));
  ok(res, list);
});
route('GET', '/groups', (req, res, u) => {
  if (!db.groups) db.groups = [];
  const list = db.groups.slice().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    .map(g => ({ id: g.id, name: g.name, desc: g.desc, ownerId: g.ownerId,
      owner: (db.users.find(x => x.id === g.ownerId) || {}).nickname || '',
      memberCount: g.members.length, momentsCount: (g.moments || []).length,
      joined: g.members.includes(u.id) }));
  ok(res, list);
});
route('GET', '/groups/:id', (req, res, u) => {
  if (!db.groups) db.groups = [];
  const g = db.groups.find(x => x.id === req.params.id);
  if (!g) return fail(res, 7202, '圈子不存在');
  const owner = db.users.find(x => x.id === g.ownerId);
  ok(res, { id: g.id, name: g.name, desc: g.desc, ownerId: g.ownerId, ownerName: owner ? owner.nickname : '',
    memberCount: g.members.length, joined: g.members.includes(u.id),
    moments: (g.moments || []).slice().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).map(m => _momentOut(m, u)) });
});
route('POST', '/groups/:id/moments', (req, res, u, b) => {
  if (!db.groups) db.groups = [];
  const g = db.groups.find(x => x.id === req.params.id);
  if (!g) return fail(res, 7202, '圈子不存在');
  if (!g.members.includes(u.id)) return fail(res, 7203, '你还没加入该圈子');
  const text = String(b.text || '').trim().slice(0, 1000);
  if (!text) return fail(res, 7001, '动态内容不能为空');
  if (!g.moments) g.moments = [];
  const m = { id: uid(), groupId: g.id, userId: u.id, text,
    images: Array.isArray(b.images) ? b.images.slice(0, 9).map(String) : [],
    tags: Array.isArray(b.tags) ? b.tags.slice(0, 6).map(String) : [],
    createdAt: new Date().toISOString(), likes: [], comments: [] };
  g.moments.push(m); store.save();
  awardPoints(u, 2);
  ok(res, { id: m.id });
});

// --- 会话与消息 ---
route('GET', '/chats', (req, res, u) => ok(res, db.chats.filter(c => c.ownerId === u.id)));
route('POST', '/chats', (req, res, u, b) => {
  const agent = agentOf(u, b.agentId);
  if (!agent) return fail(res, 4005, 'AI 角色不存在');
  let chat = db.chats.find(c => c.ownerId === u.id && c.type === 'ai' && c.peerId === agent.id);
  if (!chat) { chat = { id: uid(), ownerId: u.id, type: 'ai', peerId: agent.id, title: agent.name, avatar: agent.avatar, createdAt: new Date().toISOString() }; db.chats.push(chat); store.save(); }
  ok(res, chat);
});
route('GET', '/chats/:id/messages', (req, res, u, b, q) => {
  const chat = db.chats.find(c => c.id === req.params.id && c.ownerId === u.id);
  if (!chat) return fail(res, 4001, '会话不存在');
  let list = db.messages.filter(m => m.chatId === chat.id);
  if (q.before) list = list.filter(m => m.createdAt < q.before);
  const limit = Math.min(50, Number(q.limit || 20));
  const page = list.slice(-limit).reverse();
  ok(res, { messages: page, hasMore: list.length > limit });
});
route('POST', '/chats/:id/messages', (req, res, u, b) => {
  const chat = db.chats.find(c => c.id === req.params.id && c.ownerId === u.id);
  if (!chat) return fail(res, 4001, '会话不存在');
  const m = { id: uid(), chatId: chat.id, senderType: 'user', senderId: u.id,
    type: ['text', 'image', 'file', 'sticker', 'gif'].includes(b.type) ? b.type : 'text',
    content: String(b.content || '').slice(0, 100000), fileName: b.fileName || null, status: 'sent',
    createdAt: new Date().toISOString() };
  db.messages.push(m); store.save(); ok(res, m);
});
route('POST', '/chats/:id/ai', aiChat);

// --- AI 智能体 ---
route('GET', '/agents', (req, res, u) => ok(res, db.agents.filter(a => a.ownerId === u.id)));
route('POST', '/agents', (req, res, u, b) => {
  if (!String(b.name || '').trim()) return fail(res, 7001, '名称不能为空');
  const a = { id: uid(), ownerId: u.id, name: String(b.name).slice(0, 30), avatar: String(b.avatar || '✨').slice(0, 4),
    persona: String(b.persona || '').slice(0, 500), gender: b.gender || '保密', style: String(b.style || '').slice(0, 100),
    providerId: b.providerId || null, system: false };
  db.agents.push(a);
  db.chats.push({ id: uid(), ownerId: u.id, type: 'ai', peerId: a.id, title: a.name, avatar: a.avatar, createdAt: new Date().toISOString() });
  store.save(); ok(res, a);
});
route('PUT', '/agents/:id', (req, res, u, b) => {
  const a = agentOf(u, req.params.id); if (!a) return fail(res, 7002, 'AI 角色不存在');
  for (const k of ['name', 'avatar', 'persona', 'gender', 'style', 'providerId']) if (k in b) a[k] = b[k];
  store.save(); ok(res, a);
});
route('DELETE', '/agents/:id', (req, res, u) => {
  const a = agentOf(u, req.params.id);
  if (!a) return fail(res, 7002, 'AI 角色不存在');
  if (a.system) return fail(res, 7003, '「学习助手」为预置角色，可编辑但不可删除');
  db.agents = db.agents.filter(x => x.id !== a.id);
  db.chats = db.chats.filter(c => !(c.ownerId === u.id && c.peerId === a.id));
  store.save(); ok(res, { deleted: true });
});

// --- AI 厂商配置 ---
route('GET', '/ai/vendors', (req, res) => ok(res, Object.entries(AI.VENDORS).map(([k, v]) => ({ key: k, ...v }))));
route('GET', '/ai/providers', (req, res, u) => ok(res, db.providers.filter(p => p.ownerId === u.id).map(AI.publicProvider)));
route('POST', '/ai/providers', createProvider);
route('POST', '/ai/providers/:id/test', (req, res, u) => testProvider(req, res, u, req.params.id));
route('GET', '/ai/usage', (req, res, u) => ok(res, db.usage.filter(x => x.ownerId === u.id)
  .map(x => ({ ...x, provider: (() => { const p = db.providers.find(pp => pp.id === x.providerId); return p ? AI.publicProvider(p) : null; })() }))));

// --- AI 动作 ---
route('GET', '/actions', (req, res) => ok(res, Actions.REGISTRY.map(({ name, desc, risk, params }) => ({ name, desc, risk, params }))));
route('POST', '/actions/execute', (req, res, u, b) => ok(res, Actions.execute(u.id, b.action, b.params)));
route('POST', '/actions/undo', (req, res, u, b) => ok(res, Actions.undo(u.id, b.undoToken)));

// --- 单词 ---
route('GET', '/words', (req, res, u) => ok(res, store.of('words', u.id)));
route('POST', '/words/import', (req, res, u, b) => {
  const arr = Array.isArray(b.words) ? b.words : [];
  let n = 0;
  for (const w of arr) {
    if (!w.word || !w.meaning) continue;
    db.words.push({ id: uid(), ownerId: u.id, word: String(w.word).slice(0, 60), phonetic: String(w.phonetic || ''),
      meaning: String(w.meaning).slice(0, 200), example: String(w.example || ''), interval: 0, reps: 0, ef: 2.5,
      dueAt: new Date().toISOString(), createdAt: new Date().toISOString() });
    n++;
  }
  store.save(); ok(res, { imported: n });
});
route('POST', '/words/import/ocr', async (req, res, u, b) => {
  // AI 识别图片词表：需已配置多模态厂商
  const p = db.providers.find(x => x.ownerId === u.id && x.multimodal);
  if (!p) return fail(res, 8001, '请先配置一个支持多模态（识图）的厂商模型');
  try {
    const r = await AI.chat(p, [{ role: 'user', content: '识别图片中的单词表，只输出 JSON 数组，元素字段：word,phonetic,meaning,example' }],
      '你是 OCR 助手。只输出 JSON，不要输出其他文字。');
    const m = r.text.match(/\[[\s\S]*\]/);
    const words = m ? JSON.parse(m[0]) : [];
    ok(res, { words, needConfirm: true }); // 前端进入校对页确认后调 /words/import
  } catch (e) { fail(res, 8002, 'OCR 失败：' + e.message); }
});
route('POST', '/words/review', (req, res, u, b) => {
  const w = db.words.find(x => x.id === b.wordId && x.ownerId === u.id);
  if (!w) return fail(res, 8003, '单词不存在');
  Object.assign(w, sm2Update(w, Number(b.grade) || 0));
  store.save(); ok(res, w);
});
route('GET', '/words/search', (req, res, u, b, q) => {
  const s = (q.q || '').toLowerCase();
  ok(res, store.of('words', u.id).filter(w => w.word.toLowerCase().includes(s) || w.meaning.includes(s)).slice(0, 20));
});

// --- 课程表 ---
route('GET', '/timetable/courses', (req, res, u) => ok(res, store.of('courses', u.id)));
route('POST', '/timetable/courses', (req, res, u, b) => {
  if (!String(b.name || '').trim()) return fail(res, 9001, '课程名不能为空');
  const c = { id: uid(), ownerId: u.id, name: String(b.name).slice(0, 40), teacher: String(b.teacher || ''),
    className: String(b.className || ''), room: String(b.room || ''), color: String(b.color || '#4f7cff'),
    note: String(b.note || ''), bilibiliUrl: String(b.bilibiliUrl || '') };
  db.courses.push(c); store.save(); ok(res, c);
});
route('PUT', '/timetable/courses/:id', (req, res, u, b) => {
  const c = db.courses.find(x => x.id === req.params.id && x.ownerId === u.id);
  if (!c) return fail(res, 9002, '课程不存在');
  for (const k of ['name', 'teacher', 'className', 'room', 'color', 'note', 'bilibiliUrl']) if (k in b) c[k] = String(b[k]);
  store.save(); ok(res, c);
});
route('DELETE', '/timetable/courses/:id', (req, res, u) => {
  db.courses = db.courses.filter(x => !(x.id === req.params.id && x.ownerId === u.id));
  db.cells = db.cells.filter(x => !(x.courseId === req.params.id && x.ownerId === u.id));
  store.save(); ok(res, { deleted: true });
});
route('GET', '/timetable/cells', (req, res, u) => ok(res, store.of('cells', u.id)));
route('PUT', '/timetable/cells', (req, res, u, b) => {
  const key = String(b.key || '');
  if (!/^[1-7]-(0|[1-9]|10)$/.test(key)) return fail(res, 9003, '格子 key 格式应为 天-节次，如 1-1');
  if (!b.courseId) { db.cells = db.cells.filter(x => !(x.ownerId === u.id && x.key === key)); store.save(); return ok(res, { removed: true }); }
  let cell = db.cells.find(x => x.ownerId === u.id && x.key === key);
  if (!cell) { cell = { id: uid(), ownerId: u.id, key }; db.cells.push(cell); }
  cell.courseId = b.courseId; cell.span = Number(b.span || 1); cell.reminderMin = Number(b.reminderMin ?? 10);
  store.save(); ok(res, cell);
});
// 导出 ICS
route('GET', '/timetable/export.ics', (req, res, u) => {
  const cells = store.of('cells', u.id);
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//LiquidGlass//Timetable//CN'];
  for (const c of cells) {
    const course = db.courses.find(x => x.id === c.courseId); if (!course) continue;
    lines.push('BEGIN:VEVENT', 'UID:' + c.id, 'SUMMARY:' + course.name,
      'DESCRIPTION:' + `${course.teacher} ${course.className} ${course.room}`.trim(),
      'LOCATION:' + course.room, 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(lines.join('\r\n'));
});

// --- 用量 ---
route('GET', '/usage', (req, res, u) => ok(res, db.usage.filter(x => x.ownerId === u.id)));

/* ==================== 用户通知箱 ==================== */
// 读取「发给我的 + 全员广播」，按时间倒序
route('GET', '/notifications', (req, res, u) => {
  const mine = db.notifications.filter(n => n.userId === null || n.userId === u.id)
    .map(n => ({ id: n.id, title: n.title, body: n.body, sender: n.sender || '智学团队',
      type: n.type || 'system', icon: n.icon || '📢',
      createdAt: n.createdAt, broadcast: n.userId === null, read: (n.readBy || []).includes(u.id) }));
  mine.reverse();
  ok(res, mine.slice(0, 100));
});
route('POST', '/notifications/read', (req, res, u, b) => {
  const n = db.notifications.find(x => x.id === b.id && (x.userId === null || x.userId === u.id));
  if (!n) return fail(res, 10001, '通知不存在');
  n.readBy = n.readBy || [];
  if (!n.readBy.includes(u.id)) n.readBy.push(u.id);
  store.save(); ok(res, { read: true });
});
route('POST', '/notifications/read-all', (req, res, u) => {
  for (const n of db.notifications) {
    if (n.userId === null || n.userId === u.id) {
      n.readBy = n.readBy || [];
      if (!n.readBy.includes(u.id)) n.readBy.push(u.id);
    }
  }
  store.save(); ok(res, { readAll: true });
});

/* ==================== 管理员后台 ==================== */
function isAdmin(user) { return !!user && db.admins.includes(user.id); }
function adminOnly(req, res, user) {
  if (!isAdmin(user)) { fail(res, 403, '无管理员权限'); return false; }
  return true;
}

// 仪表盘统计
route('GET', '/admin/stats', (req, res, u) => {
  if (!adminOrKey(req, res, u)) return;
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  ok(res, {
    users: db.users.length,
    banned: db.users.filter(x => x.banned).length,
    online: Object.keys(db.sessions).length,
    newUsers24h: db.users.filter(x => new Date(x.createdAt).getTime() > dayAgo).length,
    messages: db.messages.length,
    agents: db.agents.length,
    friends: db.friends.filter(f => f.status === 'accepted').length,
    words: db.words.length,
    courses: db.courses.length,
    logins24h: db.loginLogs.filter(x => x.ok && new Date(x.createdAt).getTime() > dayAgo).length,
    loginFails24h: db.loginLogs.filter(x => !x.ok && new Date(x.createdAt).getTime() > dayAgo).length,
    admins: db.admins.length,
    groups: (db.groups || []).length,
    checkinsTotal: db.users.reduce((s, x) => s + ((x.checkin && x.checkin.total) || 0), 0),
    moments: (db.moments || []).length,
  });
});

// 用户列表（搜索 uid/email/nickname/shortId）
route('GET', '/admin/users', (req, res, u, b, q) => {
  if (!adminOrKey(req, res, u)) return;
  const s = String(q.q || '').trim().toLowerCase();
  let list = db.users;
  if (s) list = list.filter(x => x.email.includes(s) || x.uid.includes(s) || (x.shortId || '').includes(s) || (x.nickname || '').toLowerCase().includes(s));
  ok(res, list.map(x => ({
    id: x.id, email: x.email, uid: x.uid, shortId: x.shortId, nickname: x.nickname,
    createdAt: x.createdAt, lastLoginAt: x.lastLoginAt || null, banned: !!x.banned,
    admin: db.admins.includes(x.id),
    agents: db.agents.filter(a => a.ownerId === x.id).length,
    messages: db.messages.filter(m => db.chats.some(c => c.id === m.chatId && c.ownerId === x.id)).length,
  })));
});

// 用户详情
route('GET', '/admin/users/:id', (req, res, u) => {
  if (!adminOrKey(req, res, u)) return;
  const x = db.users.find(y => y.id === req.params.id);
  if (!x) return fail(res, 10002, '用户不存在');
  const chatIds = db.chats.filter(c => c.ownerId === x.id).map(c => c.id);
  ok(res, {
    user: { id: x.id, email: x.email, uid: x.uid, shortId: x.shortId, nickname: x.nickname, bio: x.bio,
      gender: x.gender, orientation: x.orientation, createdAt: x.createdAt, lastLoginAt: x.lastLoginAt || null, banned: !!x.banned },
    admin: db.admins.includes(x.id),
    stats: {
      chats: chatIds.length,
      messages: db.messages.filter(m => chatIds.includes(m.chatId)).length,
      agents: db.agents.filter(a => a.ownerId === x.id).length,
      friends: db.friends.filter(f => f.status === 'accepted' && (f.a === x.id || f.b === x.id)).length,
      words: db.words.filter(w => w.ownerId === x.id).length,
      courses: db.courses.filter(c => c.ownerId === x.id).length,
    },
  });
});

// 禁用 / 解禁（禁用后该用户所有会话立即失效）
route('POST', '/admin/users/:id/ban', (req, res, u, b) => {
  if (!adminOrKey(req, res, u)) return;
  const x = db.users.find(y => y.id === req.params.id);
  if (!x) return fail(res, 10002, '用户不存在');
  if (db.admins.includes(x.id)) return fail(res, 10003, '不能禁用管理员账号');
  x.banned = !!b.banned;
  if (x.banned) for (const t of Object.keys(db.sessions)) if (db.sessions[t].userId === x.id) delete db.sessions[t];
  store.saveNow();
  log(`[admin] ${u.email} ${x.banned ? '禁用' : '解禁'}用户 ${x.email}`);
  ok(res, { banned: x.banned });
});

// 给单个用户发通知（App 内通知中心可见）
route('POST', '/admin/users/:id/notify', (req, res, u, b) => {
  if (!adminOrKey(req, res, u)) return;
  const x = db.users.find(y => y.id === req.params.id);
  if (!x) return fail(res, 10002, '用户不存在');
  const title = String(b.title || '').trim().slice(0, 60);
  const body = String(b.body || '').trim().slice(0, 500);
  if (!title || !body) return fail(res, 10004, '标题与内容不能为空');
  const n = { id: uid(), userId: x.id, title, body, sender: u.nickname || u.email,
    type: String(b.type || 'system').slice(0, 20), icon: String(b.icon || '📢').slice(0, 8),
    readBy: [], createdAt: new Date().toISOString() };
  db.notifications.push(n); store.save();
  ok(res, n);
});

// 全员广播
route('POST', '/admin/broadcast', (req, res, u, b) => {
  if (!adminOrKey(req, res, u)) return;
  const title = String(b.title || '').trim().slice(0, 60);
  const body = String(b.body || '').trim().slice(0, 500);
  if (!title || !body) return fail(res, 10004, '标题与内容不能为空');
  const n = { id: uid(), userId: null, title, body, sender: u.nickname || u.email,
    type: String(b.type || 'system').slice(0, 20), icon: String(b.icon || '📢').slice(0, 8),
    readBy: [], createdAt: new Date().toISOString() };
  db.notifications.push(n); store.saveNow();
  log(`[admin] 全员广播：${title}`);
  ok(res, n);
});

// 管理概览：关键指标（在线人数 / 总用户 / 动态 / 好友关系数）
route('GET', '/admin/stats', (req, res, u) => {
  if (!adminOrKey(req, res, u)) return;
  if (!db.moments) db.moments = [];
  if (!db.blocks) db.blocks = [];
  ok(res, {
    online: Object.keys(db.sessions || {}).length,
    users: db.users.length,
    moments: db.moments.length,
    friends: (db.friends || []).filter(f => f.status === 'accepted').length,
    blocks: (db.blocks || []).length,
    notifications: (db.notifications || []).length,
  });
});

// 已下发通知列表
route('GET', '/admin/notifications', (req, res, u) => {
  if (!adminOrKey(req, res, u)) return;
  ok(res, db.notifications.map(n => ({ ...n, readCount: (n.readBy || []).length })).reverse().slice(0, 100));
});
route('DELETE', '/admin/notifications/:id', (req, res, u) => {
  if (!adminOrKey(req, res, u)) return;
  db.notifications = db.notifications.filter(n => n.id !== req.params.id);
  store.save(); ok(res, { deleted: true });
});

// 登录审计
route('GET', '/admin/login-logs', (req, res, u, b, q) => {
  if (!adminOrKey(req, res, u)) return;
  ok(res, db.loginLogs.slice(0, Number(q.limit || 100)));
});

// 任命 / 撤销管理员
route('POST', '/admin/users/:id/admin', (req, res, u, b) => {
  if (!adminOrKey(req, res, u)) return;
  const x = db.users.find(y => y.id === req.params.id);
  if (!x) return fail(res, 10002, '用户不存在');
  if (b.admin && !db.admins.includes(x.id)) db.admins.push(x.id);
  if (!b.admin) db.admins = db.admins.filter(a => a !== x.id);
  store.save(); ok(res, { admins: db.admins });
});

/* ==================== 客户端元数据 / 广告配置 / OTA ==================== */
// 安全读取 JSON 文件，失败回退默认值
function readJsonFile(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return fallback; }
}
// 管理员鉴权：登录态为管理员「或」请求头携带正确的 X-Admin-Key
function adminOrKey(req, res, user) {
  const key = process.env.ADMIN_KEY;
  if (key && String(req.headers['x-admin-key'] || '') === key) return true;
  if (isAdmin(user)) return true;
  fail(res, 403, '无管理员权限'); return false;
}

// OTA：返回最新客户端版本信息（旧客户端忽略不认识的字段 → 前向兼容）
route('GET', '/app/latest', (req, res) => {
  const v = readJsonFile(path.join(__dirname, 'version.json'), {
    version: 'V29', code: 29, apk: '/releases/zhixue-client-v28.apk',
    minCode: 12, force: false, notes: '体验优化与新增功能', size: 0,
  });
  // 若配置了公网地址，apk 下载地址也用公网（隧道 / 云场景自动切换）
  let apk = v.apk;
  if (PUBLIC_URL && apk && String(apk).startsWith('/')) {
    apk = PUBLIC_URL.replace(/\/$/, '') + apk;
  }
  ok(res, { ...v, apk, publicUrl: PUBLIC_URL || '', serverUrl: PUBLIC_URL || '' });
}, false);

// 兼容矩阵：客户端低于 minClientCode 时提示升级但不阻断
route('GET', '/app/compat', (req, res) => {
  const v = readJsonFile(path.join(__dirname, 'version.json'), { code: 29, version: 'V29' });
  ok(res, { minClientCode: 12, latestCode: v.code || 28, latestVersion: v.version || 'V29', message: '建议更新到最新版以获得完整体验' });
}, false);

// 管理员改 OTA 版本信息（后台「版本公告」用；改完 App 下次启动即提示更新）
route('POST', '/admin/version', (req, res, u, b) => {
  if (!adminOrKey(req, res, u)) return;
  const cur = readJsonFile(path.join(__dirname, 'version.json'), {}) || {};
  const code = Number(b && b.code);
  if (!code || !Number.isFinite(code) || code < 1) return fail(res, 400, '版本码必须是正整数');
  const version = String((b && b.version) || '').trim();
  if (!version) return fail(res, 400, '版本号不能为空');
  const apk = String((b && b.apk) || '').trim();
  if (apk && !/^\/releases\/[\w.\-]+\.apk$/i.test(apk)) {
    return fail(res, 400, 'APK 路径格式应为 /releases/文件名.apk');
  }
  const out = {
    ...cur,
    version,
    code,
    apk: apk || cur.apk || '',
    minCode: Number(b && b.minCode) || cur.minCode || 12,
    force: !!(b && b.force),
    notes: String((b && b.notes) || '').slice(0, 500),
    updatedAt: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(path.join(__dirname, 'version.json'), JSON.stringify(out, null, 2));
    log(`[admin] ${u ? u.email : 'key'} 更新版本 → ${version} (code ${code})`);
    ok(res, out);
  } catch (e) {
    fail(res, 500, '写版本信息失败：' + e.message);
  }
});

// 广告配置：开屏 / 信息流 / 横幅 / 插屏广告位（服务器可配，离线有兜底）
route('GET', '/ads/config', (req, res) => {
  const cfg = readJsonFile(path.join(__dirname, 'ads.json'), null);
  const ads = (cfg && Array.isArray(cfg.ads)) ? cfg.ads : (Array.isArray(cfg) ? cfg : []);
  ok(res, { ads, updatedAt: cfg && cfg.updatedAt || null });
}, false);

// 管理员配置广告位（登录管理员 或 携带 X-Admin-Key）
route('POST', '/admin/ads', (req, res, u, b) => {
  if (!adminOrKey(req, res, u)) return;
  const ads = Array.isArray(b && b.ads) ? b.ads : (Array.isArray(b) ? b : []);
  const out = { ads, updatedAt: new Date().toISOString() };
  try {
    fs.writeFileSync(path.join(__dirname, 'ads.json'), JSON.stringify(out, null, 2));
    ok(res, { saved: true, count: ads.length });
  } catch (e) {
    fail(res, 500, '写广告配置失败：' + e.message);
  }
});

/* ==================== 支付 / 会员定价配置（后端可改，App 免登录拉取） ==================== */
const PAY_FILE = path.join(__dirname, 'pay.json');
const PAY_DEFAULT = {
  enabled: true,
  contact: '1909159041@qq.com',
  contactTip: '邮箱联系开通 / 咨询会员（App 内可一键发送）',
  method: '微信 / 支付宝',
  link: '',
  qrcode: '',
  qrcodeNote: '',
  note: '开通后广告全部消失，解锁全部会员权益',
  plans: [],
};

// 支付配置：会员定价 / 联系邮箱 / 收款码 / 支付链接（全部由后端 pay.json 管理）
route('GET', '/pay/config', (req, res) => {
  const cfg = readJsonFile(PAY_FILE, PAY_DEFAULT) || PAY_DEFAULT;
  ok(res, { ...PAY_DEFAULT, ...cfg });
}, false);

// 管理员改支付配置（定价 / 邮箱 / 链接等）
route('POST', '/admin/pay', (req, res, u, b) => {
  if (!adminOrKey(req, res, u)) return;
  const cur = readJsonFile(PAY_FILE, PAY_DEFAULT) || PAY_DEFAULT;
  const out = { ...cur, ...(b || {}), updatedAt: new Date().toISOString() };
  try {
    fs.writeFileSync(PAY_FILE, JSON.stringify(out, null, 2));
    ok(res, { saved: true });
  } catch (e) {
    fail(res, 500, '写支付配置失败：' + e.message);
  }
});

// 管理员上传收款码 / 赞赏码图片（body: { data: "data:image/png;base64,..." } 或纯 base64）
route('POST', '/admin/pay/qrcode', (req, res, u, b) => {
  if (!adminOrKey(req, res, u)) return;
  const raw = String((b && b.data) || '').replace(/^data:image\/\w+;base64,/, '');
  if (!raw || raw.length < 100) return fail(res, 400, '缺少图片 base64 数据');
  if (raw.length > 6 * 1024 * 1024) return fail(res, 400, '图片过大（限 4MB）');
  const buf = Buffer.from(raw, 'base64');
  const ext = (b && b.ext) === 'jpg' ? 'jpg' : 'png';
  try {
    fs.mkdirSync(path.join(__dirname, 'uploads'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, 'uploads', 'pay-qrcode.' + ext), buf);
    // 同步更新 pay.json 里的 qrcode 路径
    const cur = readJsonFile(PAY_FILE, PAY_DEFAULT) || PAY_DEFAULT;
    cur.qrcode = '/uploads/pay-qrcode.' + ext;
    cur.updatedAt = new Date().toISOString();
    fs.writeFileSync(PAY_FILE, JSON.stringify(cur, null, 2));
    ok(res, { saved: true, qrcode: cur.qrcode });
  } catch (e) {
    fail(res, 500, '保存图片失败：' + e.message);
  }
});

/* ==================== 功能权限总表（后端可编辑，App 免登录拉取） ==================== */
// 设计：一条 feature 记录 = 一个功能点，含 4 个开关
//   enabled   展示与否（关掉即从页面消失）
//   needLogin 是否要求登录（本地模式会提示「连接服务器后可用」）
//   needVip   是否要求会员（非会员点进去显示解锁提示）
//   tip       自定义提示文案（关掉时显示，比「敬请期待」更有信息量）
// 管理员改完写盘，App 下次启动 / 手动刷新即生效，无需发版。
const FEATURE_FILE = path.join(__dirname, 'features.json');
const FEATURE_DEFAULT = { groups: [], global: {} };

function readFeatures() {
  const cfg = readJsonFile(FEATURE_FILE, null);
  if (!cfg || !Array.isArray(cfg.groups)) return FEATURE_DEFAULT;
  return cfg;
}

// 展平为 { 功能key: {...} }，App 端判断更快
function flattenFeatures(cfg) {
  const map = {};
  for (const g of cfg.groups || []) {
    for (const it of g.items || []) {
      if (!it || !it.key) continue;
      map[it.key] = {
        enabled: it.enabled !== false,
        needLogin: it.needLogin === true,
        needVip: it.needVip === true,
        tip: it.tip || '',
        group: g.key || '',
        name: it.name || it.key,
      };
    }
  }
  return map;
}

// 公开读取：App 无需登录（离线时 App 用内置默认全开）
route('GET', '/features/config', (req, res) => {
  const cfg = readFeatures();
  ok(res, {
    map: flattenFeatures(cfg),
    groups: cfg.groups || [],
    global: cfg.global || {},
    updatedAt: cfg.updatedAt || null,
  });
}, false);

// 管理员整表替换
route('POST', '/admin/features', (req, res, u, b) => {
  if (!adminOrKey(req, res, u)) return;
  const groups = Array.isArray(b && b.groups) ? b.groups : null;
  if (!groups) return fail(res, 400, '缺少 groups 数组');
  const out = {
    groups,
    global: (b && b.global) || {},
    updatedAt: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(FEATURE_FILE, JSON.stringify(out, null, 2));
    ok(res, { saved: true, count: Object.keys(flattenFeatures(out)).length });
  } catch (e) {
    fail(res, 500, '写功能配置失败：' + e.message);
  }
});

// 管理员只改单个功能（最常用的操作：把某个功能关掉/放开）
route('POST', '/admin/features/toggle', (req, res, u, b) => {
  if (!adminOrKey(req, res, u)) return;
  const key = String((b && b.key) || '').trim();
  if (!key) return fail(res, 400, '缺少功能 key');
  const cfg = readFeatures();
  let hit = null;
  for (const g of cfg.groups || []) {
    for (const it of g.items || []) {
      if (it.key === key) hit = it;
    }
  }
  if (!hit) return fail(res, 404, '没有这个功能 key：' + key);
  if (typeof (b && b.enabled) === 'boolean') hit.enabled = b.enabled;
  if (typeof (b && b.needLogin) === 'boolean') hit.needLogin = b.needLogin;
  if (typeof (b && b.needVip) === 'boolean') hit.needVip = b.needVip;
  if (typeof (b && b.tip) === 'string') hit.tip = b.tip;
  cfg.updatedAt = new Date().toISOString();
  try {
    fs.writeFileSync(FEATURE_FILE, JSON.stringify(cfg, null, 2));
    ok(res, { saved: true, item: hit });
  } catch (e) {
    fail(res, 500, '写功能配置失败：' + e.message);
  }
});

/* ==================== HTTP 服务 ==================== */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathName = url.pathname.replace(/\/+$/, '') || '/';
  const q = Object.fromEntries(url.searchParams);
  const ip = Security.clientIp(req);

  // 统一安全响应头 + CORS（所有响应都带）
  // 管理后台是单文件 HTML（内联样式/脚本），必须走页面级 CSP，否则整页被拦成白板
  const isAdminPage = (pathName === '/admin' || pathName === '/admin/') && req.method === 'GET';
  Security.setSecurityHeaders(res, isAdminPage);
  Security.corsHeaders(req, res);

  // 预检请求直接放行（带安全头）
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // 静态托管 releases/ 下的 APK（路径白名单 + 限流，供 App 内更新下载）
  if (req.method === 'GET' && pathName.startsWith('/releases/')) {
    const file = pathName.slice('/releases/'.length);
    if (!Security.checkRateLimit(ip, 'download', 30, 60 * 1000)) { res.writeHead(429); return res.end('下载过于频繁'); }
    return Security.serveRelease(req, res, file, path.join(__dirname, '..'));
  }

  // 静态托管 uploads/ 下的图片（收款码/赞赏码等；白名单扩展名 + 防穿越）
  if (req.method === 'GET' && pathName.startsWith('/uploads/')) {
    const file = pathName.slice('/uploads/'.length);
    const okExt = /\.(png|jpe?g|webp|gif)$/i;
    if (!file || /[\\/]|\.\./.test(file) || !okExt.test(file)) { res.writeHead(400); return res.end('Bad Request'); }
    if (!Security.checkRateLimit(ip, 'download', 60, 60 * 1000)) { res.writeHead(429); return res.end('过于频繁'); }
    const full = path.join(__dirname, 'uploads', file);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) { res.writeHead(404); return res.end('Not Found'); }
    const ext = path.extname(full).toLowerCase();
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=300' });
    return fs.createReadStream(full).pipe(res);
  }

  // 写接口限流（防暴破 / 防 CC）：默认 120 次/分钟
  if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
    if (!Security.checkRateLimit(ip, 'write', 120, 60 * 1000)) {
      return fail(res, 429, '请求过于频繁，请稍后再试');
    }
    // 认证类接口更严格（防爆破）
    if (pathName.startsWith('/auth/')) {
      const lim = pathName.endsWith('/send-code') ? 8 : 30;
      if (!Security.checkRateLimit(ip, 'auth', lim, 60 * 1000)) {
        return fail(res, 429, '操作过于频繁，请稍后再试');
      }
    }
  }

  // --- 根路径欢迎页（浏览器直接开 http://<IP>:端口 就能看到服务器状态）---
  if (pathName === '/' && req.method === 'GET') {
    const up = Math.floor(process.uptime());
    const upText = up >= 3600 ? `${Math.floor(up / 3600)} 小时 ${Math.floor(up % 3600 / 60)} 分`
      : up >= 60 ? `${Math.floor(up / 60)} 分 ${up % 60} 秒` : `${up} 秒`;
    const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>智学服务器 · 运行中</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:linear-gradient(135deg,#1a1a2e 0%,#16213e 50%,#0f3460 100%);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;color:#fff}
.card{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:20px;padding:36px;max-width:520px;width:100%;backdrop-filter:blur(12px);box-shadow:0 20px 60px rgba(0,0,0,.4)}
.badge{display:inline-flex;align-items:center;gap:8px;background:rgba(52,199,89,.15);border:1px solid rgba(52,199,89,.4);color:#34c759;padding:6px 14px;border-radius:999px;font-size:13px;font-weight:600;margin-bottom:18px}
.dot{width:8px;height:8px;background:#34c759;border-radius:50%;animation:pulse 1.6s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
h1{font-size:26px;margin-bottom:6px}
.sub{color:rgba(255,255,255,.55);font-size:14px;margin-bottom:24px}
table{width:100%;border-collapse:collapse;margin-bottom:24px}
td{padding:10px 0;font-size:14px;border-bottom:1px solid rgba(255,255,255,.08)}
td:first-child{color:rgba(255,255,255,.5);width:96px}
td:last-child{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;word-break:break-all}
.links{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:20px}
a{flex:1;min-width:140px;text-align:center;text-decoration:none;padding:12px;border-radius:12px;font-size:14px;font-weight:600;transition:.2s}
a.primary{background:linear-gradient(135deg,#667eea,#764ba2);color:#fff}
a.ghost{border:1px solid rgba(255,255,255,.2);color:rgba(255,255,255,.8)}
a:hover{transform:translateY(-1px);opacity:.92}
.tip{background:rgba(255,193,7,.08);border:1px solid rgba(255,193,7,.25);border-radius:12px;padding:14px;font-size:13px;line-height:1.7;color:rgba(255,255,255,.75)}
.tip b{color:#ffc107}
</style></head><body><div class="card">
<span class="badge"><span class="dot"></span>服务器运行中</span>
<h1>智学 Liquid Glass 后端</h1>
<p class="sub">如果你在浏览器里看到了这一页，说明服务器一切正常。</p>
<table>
<tr><td>运行模式</td><td>${MODE === 'phone' ? 'phone（手机 Termux）' : 'pc（电脑）'}</td></tr>
<tr><td>端口</td><td>${PORT}</td></tr>
<tr><td>已运行</td><td>${upText}</td></tr>
<tr><td>数据目录</td><td>${store.DATA_DIR}</td></tr>
</table>
<div class="links">
<a class="primary" href="/admin">打开管理后台</a>
<a class="ghost" href="/api/health">健康检查</a>
</div>
<div class="tip">
<b>手机 App 连不上？按顺序查：</b><br>
1. 手机和电脑必须连<b>同一个 WiFi</b>（别用访客网络）；<br>
2. App 里地址填 <b>http://电脑IPv4:${PORT}</b>（IPv4 在服务器启动窗口里，形如 192.168.x.x），不要填 localhost；<br>
3. Windows 首次启动会弹防火墙提示，<b>专用和公用网络都要勾「允许」</b>；<br>
4. 地址必须是 <b>http://</b> 开头、带上端口、结尾不要斜杠。
</div>
</div></body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
    return res.end(html);
  }

  // --- 管理台静态页（GET /admin）---
  if ((pathName === '/admin' || pathName === '/admin/') && req.method === 'GET') {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'admin.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
      return res.end(html);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('管理台页面缺失：' + e.message);
    }
  }

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const keys = [];
    const pat = r.pattern.replace(/:[^/]+/g, m => { keys.push(m.slice(1)); return '([^/]+)'; });
    const m = pathName.match(new RegExp('^' + pat + '$'));
    if (!m) continue;
    req.params = {}; keys.forEach((k, i) => req.params[k] = decodeURIComponent(m[i + 1]));
    try {
      const body = ['POST', 'PUT', 'DELETE'].includes(req.method) ? await readBody(req) : {};
      Security.sanitizeBody(body);
      const user = r.needAuth ? authUser(req) : null;
      // 例外：`/admin/*` 允许直接用 X-Admin-Key 通过路由级鉴权。
      // 否则脚本化改配置（curl / 自动化）必须先登录拿 token，再用 token 请求，
      // 多绕一步且 token 会过期——而 key 本身已经是「管理员凭证」。
      const isAdminApi = pathName.startsWith('/admin/');
      const hasAdminKey = isAdminApi && process.env.ADMIN_KEY &&
          String(req.headers['x-admin-key'] || '') === process.env.ADMIN_KEY;
      if (r.needAuth && !user && !hasAdminKey) return fail(res, 401, '未登录或登录已过期');
      await r.handler(req, res, user, body, q);
    } catch (e) {
      log('[error]', req.method, pathName, e.message);
      fail(res, 500, e.message || '服务器内部错误');
    }
    return;
  }
  fail(res, 404, '接口不存在：' + req.method + ' ' + pathName);
});

// 双栈监听：先绑 IPv6 '::'（同时接受 IPv4 回环映射，兼容安卓浏览器把 localhost
// 解析成 ::1 的情况）；系统不支持 IPv6 时自动降级绑 0.0.0.0（IPv4 全网卡）。
// HOST 环境变量：可指定监听网卡（默认 '::' 双栈，局域网可直接访问）
//   HOST=0.0.0.0  只听 IPv4 全网卡（内网穿透 / 云服务器常用）
//   HOST=192.168.1.5  只听指定网卡（多网卡机器按需限制）
const HOST = process.env.HOST || '::';
server.on('error', (err) => {
  if (err && err.code === 'EADDRNOTAVAIL') {
    log('IPv6 不可用，改用 IPv4 全网卡监听（0.0.0.0）');
    server.listen(PORT, HOST === '::' ? '0.0.0.0' : HOST);
  } else {
    log(`监听出错：${err && err.message}`);
  }
});
server.listen(PORT, HOST, () => {
  log(`智学服务器已启动 · 模式=${MODE} · 端口=${PORT} · 监听=${HOST} · 数据目录=${store.DATA_DIR}`);
  log(`已同时接受 IPv4 + IPv6（localhost / 127.0.0.1 都能访问）`);
  log(`局域网访问：http://<本机IP>:${PORT}  健康检查：GET /api/health`);
  log(`跨网络/外网：用内网穿透(frp/cloudflared/花生壳)或部署到云服务器，App 里把节点地址改成穿透后的域名即可`);
});

// 健康检查（无需鉴权）：附带公网地址与最低兼容客户端版本（前向兼容）
routes.push({ method: 'GET', pattern: '/api/health', needAuth: false,
  handler: (req, res) => {
    const v = readJsonFile(path.join(__dirname, 'version.json'), { code: 29, version: 'V29' });
    ok(res, {
      status: 'up', mode: MODE, port: PORT, time: new Date().toISOString(),
      publicUrl: PUBLIC_URL || '', minClientCode: 12,
      latestCode: v.code || 28, latestVersion: v.version || 'V29',
    });
  } });

process.on('SIGINT', () => { store.flush(); console.log('\n已保存数据，退出'); process.exit(0); });
process.on('SIGTERM', () => { store.flush(); process.exit(0); });
module.exports = server;
