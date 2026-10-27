'use strict';
/**
 * API Key 加密存储：AES-256-GCM
 * 密钥来自 AI_KEY_SECRET 环境变量；未设置时用机器指纹自动派生（首次运行生成并持久化）。
 * Key 永不以明文出现在日志中（本模块对外只输出密文/掩码）。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let keyCache = null;

function masterKey() {
  if (keyCache) return keyCache;
  let secret = process.env.AI_KEY_SECRET;
  if (!secret) {
    const f = path.join(require('./store').DATA_DIR, '.keysecret');
    try { secret = fs.readFileSync(f, 'utf8').trim(); }
    catch (_) {
      secret = crypto.randomBytes(32).toString('hex');
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, secret, { mode: 0o600 });
      console.log('[crypto] 已生成 AI_KEY_SECRET 并保存到', f);
    }
  }
  keyCache = crypto.createHash('sha256').update(secret).digest();
  return keyCache;
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return iv.toString('hex') + '.' + c.getAuthTag().toString('hex') + '.' + enc.toString('hex');
}

function decrypt(payload) {
  if (!payload) return null;
  const [iv, tag, data] = String(payload).split('.');
  const d = crypto.createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(iv, 'hex'));
  d.setAuthTag(Buffer.from(tag, 'hex'));
  return Buffer.concat([d.update(Buffer.from(data, 'hex')), d.final()]).toString('utf8');
}

/** 掩码展示：sk-abc...xyz */
function mask(k) {
  if (!k) return '';
  const s = String(k);
  return s.length <= 8 ? s[0] + '****' : s.slice(0, 4) + '****' + s.slice(-4);
}

module.exports = { encrypt, decrypt, mask };
