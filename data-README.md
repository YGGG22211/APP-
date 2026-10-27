# data 目录说明

服务器运行后会自动在这里生成 `db.json`——**所有数据都在这个文件里**：

- users（账号）
- sessions（登录会话）
- codes（验证码）
- friends / chats / messages（好友与聊天）
- agents / providers（AI 智能体与模型配置）
- words / courses / cells（单词、课程、课表）
- settings（各端设置）
- usage（AI 用量统计）
- admins（管理员列表）
- notifications（通知记录）
- loginLogs（登录审计）

## 备份

停服务器 → 复制整个 `data/` 文件夹 → 完成。

## 恢复

停服务器 → 用备份的 `data/` 覆盖当前目录 → 重启。

## 重置（清空所有账号，谨慎！）

停服务器 → 删除 `db.json` → 重启 → 第一个注册的用户自动成为新管理员。
