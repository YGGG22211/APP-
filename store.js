'use strict';
/**
 * 共享存储层：JSON 文件数据库（零依赖，PC / Termux 通用）
 * DATA_DIR 环境变量指定数据目录；写入带防抖，退出时 flush。
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_DB = {
  users: [],        // {id,email,pwdHash,salt,uid,shortId,nickname,bio,gender,orientation,createdAt,banned,lastLoginAt}
  sessions: {},     // token -> {userId, createdAt}
  codes: {},        // email -> {code, purpose, expiresAt}  注册/重置验证码
  friends: [],      // {id, a, b, status:'pending'|'accepted', requester, createdAt}
  blocks: [],       // {id, a, b, createdAt}  拉黑关系：a 拉黑了 b
  chats: [],        // {id, ownerId, type:'ai'|'friend', peerId, title, avatar, createdAt}
  messages: [],     // {id, chatId, senderType:'user'|'ai'|'friend', senderId, type, content, fileName, status, createdAt}
  agents: [],       // {id, ownerId, name, avatar, persona, gender, style, providerId, system:true}
  providers: [],    // {id, ownerId, vendor, name, baseUrl, model, apiKey(密文), multimodal, pricing, locked}
  words: [],        // {id, ownerId, word, phonetic, meaning, example, ef, interval, reps, dueAt}
  courses: [],      // {id, ownerId, name, teacher, className, room, color, note, bilibiliUrl}
  cells: [],        // {id, ownerId, key:'day-period', courseId, span, reminderMin}
  settings: [],     // {ownerId, key, value}
  usage: [],        // {ownerId, providerId, promptTokens, completionTokens, requests, updatedAt}
  actions: [],      // {id, ownerId, action, params, status, result, undoToken, createdAt}
  admins: [],       // 管理员 userId 列表（首个注册用户自动成为管理员）
  notifications: [],// 管理员下发的通知 {id, userId:null=全员, title, body, sender, type, icon, createdAt, readBy:[]}
  moments: [],      // 朋友圈/动态 {id, userId, text, images:[], tags:[], createdAt, likes:[userId], comments:[{id,userId,name,text,createdAt}]}
  groups: [],       // 圈子/群聊 {id, name, desc, ownerId, members:[userId], moments:[动态], createdAt}
  loginLogs: []     // {userId, email, ok, ip, ua, createdAt} 登录审计
};

// 独立部署时数据目录位于包内：<包目录>/data（src 的上一级）
// 可用环境变量 DATA_DIR 覆盖到任意位置（如 U 盘、其他磁盘）
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

let db = null;
let saveTimer = null;

function init() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    try {
      db = Object.assign(structuredClone(DEFAULT_DB), JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
      console.log(`[store] 已加载数据库：${DB_FILE}`);
    } catch (e) {
      console.error('[store] 数据库文件损坏，已备份并新建：', e.message);
      fs.copyFileSync(DB_FILE, DB_FILE + '.bak.' + Date.now());
      db = structuredClone(DEFAULT_DB);
    }
  } else {
    db = structuredClone(DEFAULT_DB);
    saveNow();
    console.log(`[store] 已初始化新数据库：${DB_FILE}`);
  }
  return db;
}

function get() {
  if (!db) init();
  return db;
}

function saveNow() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DB_FILE);
}

function save() { // 防抖写入
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 300);
}

function flush() { clearTimeout(saveTimer); if (db) saveNow(); }

/** 按 ownerId 隔离的集合访问器 */
function of(collection, ownerId) {
  return get()[collection].filter(x => x.ownerId === ownerId);
}

module.exports = { init, get, save, saveNow, flush, of, DATA_DIR, DB_FILE };
