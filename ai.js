'use strict';
/**
 * 多厂商 AI 适配层（禁止写死单一厂商）
 * 内置厂商全部走 OpenAI 兼容协议（业内通用），Anthropic / Google 单独适配。
 * 自定义厂商：手动填 vendor/baseUrl/model/apiKey，自动探测协议。
 */
const store = require('./store');
const { decrypt, mask } = require('./crypto');
const { log } = require('./util');

const VENDORS = {
  openai:    { label: 'OpenAI',     baseUrl: 'https://api.openai.com/v1',            models: ['gpt-4o-mini', 'gpt-4o'],            usage: true,  multimodal: true },
  anthropic: { label: 'Anthropic',  baseUrl: 'https://api.anthropic.com/v1',         models: ['claude-3-5-sonnet', 'claude-3-haiku'], usage: true,  multimodal: true, protocol: 'anthropic' },
  google:    { label: 'Google',     baseUrl: 'https://generativelanguage.googleapis.com/v1beta', models: ['gemini-1.5-flash', 'gemini-1.5-pro'], usage: true, multimodal: true, protocol: 'google' },
  glm:       { label: '智谱 GLM',   baseUrl: 'https://open.bigmodel.cn/api/paas/v4',  models: ['glm-4-flash', 'glm-4-plus'],        usage: true,  multimodal: true },
  deepseek:  { label: 'DeepSeek',   baseUrl: 'https://api.deepseek.com/v1',           models: ['deepseek-chat', 'deepseek-reasoner'], usage: true, multimodal: false },
  qwen:      { label: '通义千问',   baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-plus', 'qwen-max'], usage: true, multimodal: true },
  kimi:      { label: 'Kimi',       baseUrl: 'https://api.moonshot.cn/v1',            models: ['moonshot-v1-8k', 'moonshot-v1-32k'], usage: true, multimodal: false },
  doubao:    { label: '豆包',       baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', models: ['doubao-pro-32k'],               usage: false, multimodal: true },
  custom:    { label: '自定义厂商', baseUrl: '',                                      models: [],                                   usage: false, multimodal: false },
};

function meta(vendor) { return VENDORS[vendor] || VENDORS.custom; }

function apiKeyOf(p) { return decrypt(p.apiKeyEnc); }

/** 测试连接：发一条 1 token 的最小请求 */
async function testConnection(p) {
  const key = apiKeyOf(p);
  if (!key) return { ok: false, error: '未配置 API Key' };
  const m = meta(p.vendor);
  try {
    let r;
    if (m.protocol === 'anthropic') {
      r = await fetch(p.baseUrl + '/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: p.model, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
      });
    } else if (m.protocol === 'google') {
      r = await fetch(`${p.baseUrl}/models/${p.model}:generateContent?key=${key}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: 'hi' }] }] }),
      });
    } else {
      r = await fetch(p.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
        body: JSON.stringify({ model: p.model, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
      });
    }
    const text = await r.text();
    if (!r.ok) {
      let err = text.slice(0, 300);
      try { err = JSON.parse(text).error?.message || JSON.parse(text).message || err; } catch (_) {}
      return { ok: false, error: `HTTP ${r.status}：${err}` };
    }
    return { ok: true, message: '已连接', usage: usageSupported(p) };
  } catch (e) {
    return { ok: false, error: '网络错误：' + e.message };
  }
}

function usageSupported(p) { return !!meta(p.vendor).usage; }

/**
 * 统一对话（非流式）。messages: [{role, content}]，content 支持图片（dataURL）时仅多模态可用。
 * 返回 {text, usage:{promptTokens,completionTokens}}
 */
async function chat(p, messages, systemPrompt) {
  const key = apiKeyOf(p);
  if (!key) throw new Error('该厂商未配置 API Key');
  const m = meta(p.vendor);
  const sys = systemPrompt ? [{ role: 'system', content: systemPrompt }] : [];

  async function record(u) {
    if (u) addUsage(p.ownerId, p.id, u.promptTokens || 0, u.completionTokens || 0);
  }

  if (m.protocol === 'anthropic') {
    const r = await fetch(p.baseUrl + '/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: p.model, max_tokens: 2048, system: systemPrompt || undefined,
        messages: messages.map(x => ({ role: x.role === 'assistant' ? 'assistant' : 'user', content: x.content })) }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error?.message || ('HTTP ' + r.status));
    await record({ promptTokens: j.usage?.input_tokens, completionTokens: j.usage?.output_tokens });
    return { text: (j.content || []).map(c => c.text || '').join(''), usage: j.usage };
  }
  if (m.protocol === 'google') {
    const r = await fetch(`${p.baseUrl}/models/${p.model}:generateContent?key=${key}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contents: messages.map(x => ({ role: x.role === 'assistant' ? 'model' : 'user', parts: [{ text: x.content }] })) }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error?.message || ('HTTP ' + r.status));
    await record({ promptTokens: j.usageMetadata?.promptTokenCount, completionTokens: j.usageMetadata?.candidatesTokenCount });
    return { text: (j.candidates?.[0]?.content?.parts || []).map(x => x.text || '').join(''), usage: j.usageMetadata };
  }
  // OpenAI 兼容
  const r = await fetch(p.baseUrl + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify({ model: p.model, messages: [...sys, ...messages] }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || ('HTTP ' + r.status));
  await record(j.usage ? { promptTokens: j.usage.prompt_tokens, completionTokens: j.usage.completion_tokens } : null);
  return { text: j.choices?.[0]?.message?.content || '', usage: j.usage };
}

function addUsage(ownerId, providerId, pt, ct) {
  const db = store.get();
  let u = db.usage.find(x => x.ownerId === ownerId && x.providerId === providerId);
  if (!u) { u = { ownerId, providerId, promptTokens: 0, completionTokens: 0, requests: 0, updatedAt: null }; db.usage.push(u); }
  u.promptTokens += pt || 0; u.completionTokens += ct || 0; u.requests += 1;
  u.updatedAt = new Date().toISOString();
  store.save();
}

/** 供路由展示的 provider 公开字段（Key 只给掩码） */
function publicProvider(p) {
  const m = meta(p.vendor);
  return { id: p.id, vendor: p.vendor, vendorLabel: m.label, name: p.name, baseUrl: p.baseUrl,
    model: p.model, multimodal: p.multimodal != null ? p.multimodal : m.multimodal,
    pricing: p.pricing || '', locked: !!p.locked, keyMask: mask(decrypt(p.apiKeyEnc)),
    usageSupported: m.usage };
}

module.exports = { VENDORS, meta, publicProvider, apiKeyOf, testConnection, chat, usageSupported, addUsage };
