'use strict';
/**
 * AI 动作注册表：只操作 App 内部功能，不做跨 App 自动点击。
 * 每个动作：name / desc / params / risk(read|low|medium|high) / run / undo(可选)
 * 执行策略：读操作直接执行；低风险直接执行；中高风险执行后返回 undoToken 支持撤销。
 */
const store = require('./store');
const { uid, log } = require('./util');
const { sm2Update } = require('./sm2');

function settingsOf(db, ownerId, key, dflt) {
  const s = db.settings.find(x => x.ownerId === ownerId && x.key === key);
  return s ? s.value : dflt;
}
function setSetting(db, ownerId, key, value) {
  const s = db.settings.find(x => x.ownerId === ownerId && x.key === key);
  if (s) s.value = value; else db.settings.push({ ownerId, key, value });
  store.save();
}

const REGISTRY = [
  {
    name: 'checkIn', desc: '打卡签到（今日学习打卡）', risk: 'low',
    params: {},
    run(ctx) {
      const db = store.get();
      const today = new Date().toISOString().slice(0, 10);
      let rec = db.settings.find(x => x.ownerId === ctx.ownerId && x.key === 'checkin');
      let days = rec?.value?.days || [];
      if (days.includes(today)) return { ok: true, message: `今天（${today}）已经打过卡啦`, already: true };
      days.push(today);
      setSetting(db, ctx.ownerId, 'checkin', { last: today, days });
      return { ok: true, message: `打卡成功 ✅ 已连续签到 ${days.length} 天`, days: days.length };
    },
  },
  {
    name: 'getCheckInStatus', desc: '查询签到状态', risk: 'read', params: {},
    run(ctx) {
      const v = settingsOf(store.get(), ctx.ownerId, 'checkin', { last: null, days: [] });
      return { ok: true, lastCheckIn: v.last, totalDays: v.days.length, checkedToday: v.days.includes(new Date().toISOString().slice(0, 10)) };
    },
  },
  {
    name: 'setSetting', desc: '修改 App 设置（key+value）', risk: 'medium',
    params: { key: 'string', value: 'any' },
    run(ctx) {
      const db = store.get();
      const old = settingsOf(db, ctx.ownerId, ctx.params.key, null);
      setSetting(db, ctx.ownerId, ctx.params.key, ctx.params.value);
      return { ok: true, message: `已把设置「${ctx.params.key}」改为 ${JSON.stringify(ctx.params.value)}`, undoable: true, prevValue: old };
    },
    undo(ctx, result) {
      setSetting(store.get(), ctx.ownerId, ctx.params.key, result.prevValue);
      return { ok: true, message: '已撤销设置修改' };
    },
  },
  {
    name: 'getSetting', desc: '查询设置项', risk: 'read', params: { key: 'string' },
    run(ctx) { return { ok: true, key: ctx.params.key, value: settingsOf(store.get(), ctx.ownerId, ctx.params.key, null) }; },
  },
  {
    name: 'startStudyTimer', desc: '开始上课/学习计时', risk: 'low', params: { title: 'string,可选' },
    run(ctx) {
      setSetting(store.get(), ctx.ownerId, 'studyTimer', { startedAt: Date.now(), title: ctx.params.title || '学习计时' });
      return { ok: true, message: `已开始计时：${ctx.params.title || '学习计时'}` };
    },
  },
  {
    name: 'stopStudyTimer', desc: '停止学习计时并记录时长', risk: 'low', params: {},
    run(ctx) {
      const t = settingsOf(store.get(), ctx.ownerId, 'studyTimer', null);
      if (!t) return { ok: false, message: '当前没有进行中的计时' };
      const minutes = Math.max(1, Math.round((Date.now() - t.startedAt) / 60000));
      setSetting(store.get(), ctx.ownerId, 'studyTimer', null);
      const logArr = settingsOf(store.get(), ctx.ownerId, 'studyLog', []);
      logArr.push({ title: t.title, minutes, at: new Date().toISOString() });
      setSetting(store.get(), ctx.ownerId, 'studyLog', logArr);
      return { ok: true, message: `计时结束：${t.title} 共 ${minutes} 分钟，已记入学习看板` };
    },
  },
  {
    name: 'addTodo', desc: '添加待办到学习看板', risk: 'medium', params: { title: 'string' },
    run(ctx) {
      const db = store.get();
      const list = db.settings.find(x => x.ownerId === ctx.ownerId && x.key === 'todos');
      const todos = list ? list.value : [];
      todos.push({ id: uid().slice(0, 8), title: String(ctx.params.title).slice(0, 100), done: false });
      setSetting(db, ctx.ownerId, 'todos', todos);
      return { ok: true, message: `已添加待办：${ctx.params.title}`, undoable: true, todoId: todos[todos.length - 1].id };
    },
    undo(ctx, result) {
      const list = settingsOf(store.get(), ctx.ownerId, 'todos', []);
      setSetting(store.get(), ctx.ownerId, 'todos', list.filter(t => t.id !== result.todoId));
      return { ok: true, message: '已撤销待办' };
    },
  },
  {
    name: 'searchWord', desc: '在词库中搜索单词', risk: 'read', params: { query: 'string' },
    run(ctx) {
      const q = String(ctx.params.query).toLowerCase();
      const hits = store.of('words', ctx.ownerId).filter(w => w.word.toLowerCase().includes(q) || (w.meaning || '').includes(q)).slice(0, 10);
      return { ok: true, count: hits.length, words: hits.map(w => ({ word: w.word, phonetic: w.phonetic, meaning: w.meaning })) };
    },
  },
];

/** 解析 AI 输出中的动作调用 JSON：约定模型返回 {"action":"...","params":{...}} */
function parseActionCall(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    if (j && typeof j.action === 'string' && REGISTRY.some(r => r.name === j.action)) return j;
  } catch (_) {}
  return null;
}

function execute(ownerId, action, params) {
  const def = REGISTRY.find(r => r.name === action);
  if (!def) return { ok: false, message: `未注册的动作：${action}` };
  const ctx = { ownerId, params: params || {} };
  let result, undoToken = null;
  try { result = def.run(ctx); }
  catch (e) { result = { ok: false, message: '执行异常：' + e.message }; }
  if (result && result.undoable) {
    undoToken = uid().slice(0, 12);
    store.get().actions.push({ id: uid().slice(0, 12), ownerId, action, params: params || {}, status: 'done', result, undoToken, createdAt: new Date().toISOString() });
    store.save();
  }
  log(`[action] ${action} user=${ownerId} ok=${result?.ok}`);
  return { ...result, undoToken, risk: def.risk };
}

function undo(ownerId, undoToken) {
  const db = store.get();
  const rec = db.actions.find(a => a.ownerId === ownerId && a.undoToken === undoToken && a.status === 'done');
  if (!rec) return { ok: false, message: '找不到可撤销的操作或已撤销' };
  const def = REGISTRY.find(r => r.name === rec.action);
  if (!def || !def.undo) return { ok: false, message: '该动作不支持撤销' };
  const r = def.undo({ ownerId, params: rec.params }, rec.result);
  rec.status = 'undone'; store.save();
  return r;
}

module.exports = { REGISTRY, parseActionCall, execute, undo };
