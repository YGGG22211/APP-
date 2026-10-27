'use strict';
/** 共享工具：ID、校验、HTTP 响应 */
const crypto = require('crypto');

const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 20);
const token = () => crypto.randomBytes(24).toString('hex');

/** 固定 10 位数字 UID，全局唯一 */
function genUid(db) {
  let u;
  do { u = '10' + crypto.randomInt(10 ** 7, 10 ** 8 - 1).toString(); }
  while (db.users.some(x => x.uid === u));
  return u;
}

function json(res, code, data) {
  const body = JSON.stringify(data);
  // 注意：CORS / 安全响应头由 server.js 主处理程序统一通过 setHeader 注入，
  // 这里只负责 Content-Type，避免重复覆盖。
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

const ok = (res, data) => json(res, 0 !== 0 ? 200 : 200, { code: 0, message: 'ok', data });
const fail = (res, code, message) => json(res, 200, { code, message });

function readBody(req, limit = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

function log(...a) { console.log(new Date().toISOString(), ...a); }

module.exports = { uid, token, genUid, json, ok, fail, readBody, log };
