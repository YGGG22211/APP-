'use strict';
/**
 * 邮件服务（注册 / 重置密码验证码）
 * 默认内置 QQ 邮箱 SMTP（授权码方式，开箱即真实发信）；
 * 也可用环境变量覆盖：SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / MAIL_FROM。
 * 发送失败或未安装 nodemailer 时自动降级为「离线模式」：
 *   验证码不发送邮件，直接返回给客户端展示（服务器日志同步打印）。
 *
 * 邮件内容为品牌化 HTML：渐变头部 + 验证码卡片 + 用途说明 + 有效期 + 防骗提示。
 */
let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch (_) { /* 未安装时自动降级：验证码回退为本地展示 */ }

const HOST = process.env.SMTP_HOST || 'smtp.qq.com';
const PORT = Number(process.env.SMTP_PORT || 465);
const USER = process.env.SMTP_USER || 'zhixiannote@qq.com';
const PASS = process.env.SMTP_PASS || 'djgnteprhixiebeg';
const FROM = process.env.MAIL_FROM || USER;
const MAIL_ENABLED = !!(nodemailer && HOST && USER && PASS);

const transporter = MAIL_ENABLED ? nodemailer.createTransport({
  host: HOST, port: PORT, secure: PORT === 465,
  auth: { user: USER, pass: PASS },
  connectionTimeout: 10000,
}) : null;

if (MAIL_ENABLED) {
  console.log(`[mail] SMTP 已配置：${HOST}:${PORT}（${USER}）→ 验证码将真实发送到邮箱`);
} else {
  console.log('[mail] SMTP 未生效（未安装 nodemailer 或未配置账号）→ 离线模式：验证码将展示在返回结果与服务器日志');
}

/** 品牌化 HTML 邮件模板 */
function buildHtml(code, purpose) {
  const isReset = purpose === 'reset';
  const action = isReset ? '重置密码' : '注册账号';
  const scene = isReset
    ? '你正在为智学账号执行「重置密码」操作。请输入下面的验证码以继续。'
    : '欢迎注册智学 · Liquid Glass！请输入下面的验证码完成账号注册。';
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f2f5fb">
<div style="display:none;font-size:0;max-height:0;overflow:hidden">智学验证码 ${code}，${action}专用，10 分钟内有效</div>
<div style="max-width:520px;margin:0 auto;padding:28px 16px 36px">
  <div style="border-radius:22px;overflow:hidden;background:#ffffff;box-shadow:0 8px 30px rgba(79,124,255,.10)">
    <div style="padding:26px 26px 22px;background:linear-gradient(135deg,#4f7cff 0%,#9a6bff 100%);color:#fff">
      <div style="font-size:20px;font-weight:800;letter-spacing:.5px">🫧 智学 · Liquid Glass</div>
      <div style="font-size:12px;opacity:.85;margin-top:4px">AI 陪伴 × 学习助手</div>
    </div>
    <div style="padding:26px">
      <div style="font-size:15px;font-weight:800;color:#1f2937">${action}验证码</div>
      <div style="font-size:12.5px;color:#6b7280;line-height:1.7;margin-top:8px">${scene}</div>
      <div style="margin:18px 0;padding:16px;border:2px dashed #c7d2fe;border-radius:14px;background:#f5f7ff;text-align:center">
        <div style="font-size:32px;font-weight:900;letter-spacing:8px;color:#4f7cff;font-family:Menlo,Consolas,monospace">${code}</div>
        <div style="font-size:11px;color:#9ca3af;margin-top:8px">10 分钟内有效 · 请勿转发给他人</div>
      </div>
      <div style="font-size:12px;color:#6b7280;line-height:1.8;background:#f9fafb;border-radius:10px;padding:12px 14px">
        <div style="font-weight:700;color:#374151;margin-bottom:4px">🛡️ 安全提示</div>
        · 智学工作人员不会以任何理由索要你的验证码或密码；<br>
        · 如非本人操作，请忽略本邮件，账号不会受到影响；<br>
        · 切勿将验证码告知陌生来电或短信中的人员。
      </div>
      <div style="font-size:11px;color:#9ca3af;margin-top:16px;text-align:center">
        本邮件由系统自动发送，请勿直接回复<br>
        智学 Liquid Glass · 用心陪伴每一次学习
      </div>
    </div>
  </div>
</div>
</body></html>`;
}

/** 发送验证码；purpose: 'register' | 'reset'；失败时抛出，由上层决定是否回退 devCode */
async function sendCode(email, code, purpose) {
  if (!transporter) throw new Error('未安装 nodemailer（npm install nodemailer）');
  const isReset = purpose === 'reset';
  const info = await transporter.sendMail({
    from: `智学 Liquid Glass <${FROM}>`,
    to: email,
    subject: `【智学】${isReset ? '重置密码' : '注册'}验证码 ${code}`,
    text: `你的${isReset ? '重置密码' : '注册'}验证码是：${code}（10 分钟内有效）。如非本人操作请忽略本邮件。智学工作人员不会索要验证码，请勿转发。`,
    html: buildHtml(code, purpose),
  });
  return info.messageId;
}

/**
 * 用户问题反馈 / 办理申请：走同一条已配置好的 SMTP 通道，
 * 直接投递到官方邮箱（officialEmail），App 端无需跳转任何邮箱 App。
 * 返回 messageId；发送失败抛出（由接口层降级提示）。
 */
async function sendFeedback({ topic = '问题反馈', contact = '', content = '', device = '' }) {
  if (!transporter) throw new Error('未安装 nodemailer（npm install nodemailer）');
  const clean = s => String(s || '').replace(/[\r\n]+/g, ' ').slice(0, 200);
  const body = String(content || '').slice(0, 4000);
  const subject = `【智学】${clean(topic) || '问题反馈'}`;
  const info = await transporter.sendMail({
    from: `智学 App 用户反馈 <${FROM}>`,
    to: process.env.FEEDBACK_TO || '1909159041@qq.com',
    subject,
    text: `${body}\n\n———— 用户信息 ————\n联系方式：${clean(contact)}\n设备/版本：${clean(device)}\n时间：${new Date().toLocaleString('zh-CN')}\n—— 此邮件由智学服务器自动转发`,
    html: `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f2f5fb">
<div style="max-width:560px;margin:0 auto;padding:24px 14px">
  <div style="border-radius:20px;overflow:hidden;background:#fff;box-shadow:0 8px 30px rgba(79,124,255,.10)">
    <div style="padding:20px 24px;background:linear-gradient(135deg,#4f7cff 0%,#9a6bff 100%);color:#fff">
      <div style="font-size:18px;font-weight:800">📮 智学 · 用户反馈</div>
      <div style="font-size:12px;opacity:.85;margin-top:4px">${clean(topic) || '问题反馈'}</div>
    </div>
    <div style="padding:22px 24px">
      <div style="white-space:pre-wrap;font-size:14px;color:#1f2937;line-height:1.8;background:#f8faff;border:1px solid #e3eaff;border-radius:12px;padding:16px">${String(content || '').slice(0, 4000).replace(/</g, '&lt;')}</div>
      <div style="font-size:12px;color:#6b7280;line-height:1.9;margin-top:14px">
        联系方式：<b>${clean(contact) || '未填写'}</b><br>
        设备 / 版本：${clean(device) || '未填写'}<br>
        时间：${new Date().toLocaleString('zh-CN')}
      </div>
    </div>
  </div>
</div>
</body></html>`,
  });
  return info.messageId;
}

module.exports = { sendCode, sendFeedback, buildHtml, transporter, USER, FROM };
