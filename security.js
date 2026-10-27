'use strict';
/**
 * 智学服务器 · 安全加固中间件（纯 Node 内置实现，零第三方依赖）
 * 提供：IP 滑动窗口限流、安全响应头、CORS 白名单、静态文件白名单、输入消毒。
 * 设计目标：在不引入任何 npm 包的前提下，把"防暴破 / 防 CC / 防注入 / 防路径穿越"
 * 的基础防护补齐，保持「零依赖、拷走即用」。
 */
const fs = require('fs');
const path = require('path');

// CORS 白名单：默认放开（App 自用 + 本机调试）；生产可配 ALLOWED_ORIGINS=https://a,https://b 收紧
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

// 会话有效期：默认 30 天（可在环境变量覆盖，单位毫秒）
const SESSION_TTL = Number(process.env.SESSION_TTL || 30 * 24 * 3600 * 1000);

/** 取客户端真实 IP（兼容反代 X-Forwarded-For） */
function clientIp(req) {
  const xff = req.headers && req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

/**
 * 滑动窗口限流：buckets[ip:bucket] = [timestamp,...]
 * 返回 true 表示放行，false 表示触发限流。
 */
const buckets = Object.create(null);
function checkRateLimit(ip, bucket, limit, windowMs) {
  const now = Date.now();
  const key = ip + ':' + bucket;
  let arr = buckets[key];
  if (!arr) arr = buckets[key] = [];
  arr = arr.filter(t => now - t < windowMs);
  if (arr.length >= limit) { buckets[key] = arr; return false; }
  arr.push(now);
  buckets[key] = arr;
  return true;
}

/** 设置安全响应头（helmet 的等价物，手写）
 *  isPage: 是否为管理后台 HTML 页面。
 *    页面需要放开内联 style/script（后台是单文件 HTML，样式与脚本都内联），
 *    否则 CSP 会把整页打成白板；API 响应仍然走最严格的 default-src 'none'。
 */
function setSecurityHeaders(res, isPage = false) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  if (isPage) {
    // 只允许本站自己的脚本/样式 + 内联；不允许外部域，不允许 eval
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: blob:; connect-src 'self' http: https:; " +
      "frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  } else {
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  }
  res.setHeader('Cache-Control', 'no-store');
  // 仅在 HTTPS 公网场景开启 HSTS
  const pub = process.env.PUBLIC_URL || '';
  if (process.env.TLS === '1' || /^https:/i.test(pub)) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

/** 设置 CORS 头（与白名单配合） */
function corsHeaders(req, res) {
  const origin = req.headers && req.headers.origin;
  if (ALLOWED_ORIGINS.length === 0) {
    // 默认放开：回显请求来源（带凭据时不能用 *，回显 origin 最稳）
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  } else if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', 'null');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Key');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Max-Age', '86400');
}

/**
 * 静态文件白名单：只允许 releases/ 下的 .apk，且禁止任何路径穿越（\ / .. 与隐藏文件）。
 * 返回安全的文件名，或 null（拒绝）。
 */
function safeReleaseFile(file) {
  if (!file) return null;
  if (/[\\/]/.test(file) || file.includes('..') || file.startsWith('.')) return null;
  if (!/\.apk$/i.test(file)) return null;
  return file;
}

/** 静态托管 releases/ 下的 APK（带限流 + 正确 Content-Type + 路径白名单） */
function serveRelease(req, res, file, baseDir) {
  const name = safeReleaseFile(file);
  if (!name) { res.writeHead(400); return res.end('非法文件'); }
  const full = path.join(baseDir, 'releases', name);
  // 二次归一化校验，确保最终路径仍在 baseDir/releases 内
  const norm = path.normalize(full);
  if (!norm.startsWith(path.join(baseDir, 'releases'))) { res.writeHead(400); return res.end('非法路径'); }
  if (!fs.existsSync(norm)) { res.writeHead(404); return res.end('文件不存在'); }
  const stat = fs.statSync(norm);
  if (!stat.isFile()) { res.writeHead(400); return res.end('非法文件'); }
  res.writeHead(200, {
    'Content-Type': 'application/vnd.android.package-archive',
    'Content-Length': stat.size,
    'Content-Disposition': 'attachment; filename="' + name + '"',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(norm).pipe(res);
}

/**
 * 输入消毒：对常见文本字段去除 < >（防脚本注入），
 * 并对超长字段截断。集中处理，避免逐个接口改。
 * 注意：不处理 base64 / 长 JSON（这些字段不含文本展示风险）。
 */
const TEXT_FIELDS = ['text', 'title', 'body', 'desc', 'bio', 'nickname', 'comment', 'name', 'content', 'subject', 'message'];
function sanitizeBody(body) {
  if (!body || typeof body !== 'object') return;
  for (const k of Object.keys(body)) {
    const v = body[k];
    if (typeof v === 'string' && TEXT_FIELDS.includes(k)) {
      body[k] = v.replace(/[<>]/g, '').trim().slice(0, 2000);
    } else if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      sanitizeBody(v);
    }
  }
}

module.exports = {
  SESSION_TTL, clientIp, checkRateLimit, setSecurityHeaders, corsHeaders,
  safeReleaseFile, serveRelease, sanitizeBody,
};
