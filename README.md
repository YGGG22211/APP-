# 智学（原智学）后端 · 手机端部署包 V29

> **这个包里只有手机端用的东西**，没有 Windows / Mac 的任何文件。
> 当前版本 **V29**（App 包名 `com.liquidglass.liquid_glass` 保持不变，升级不丢数据）。

## 新手从这里开始

| 文档 | 讲什么 |
|---|---|
| **`部署教程.md`** | ⭐ **一步一步的部署教程（手机 Termux / 云服务器两条路线）** |
| `使用教程.md` | 给用户看的完整教程（首次上手 / 连服务器 / 开会员 / 通知排障） |
| `广告开通指南.md` | 怎么开通广告 + 你要提供什么 |
| `features.json` | 功能权限总表（31 项，后端可逐项开关，改完免发版生效） |
| `TEST-NOW.md` | 本机测试 + 部署 + 新特性验收清单 |
| `跨网络访问方案.md` | 局域网/穿透/云服务器 4 种方案 |
| **`微信云托管部署指南.md`** | ⭐ 微信云托管一键上云（自带 HTTPS 公网域名，无需买服务器） |
| `releases/README.md` | 各版本发布记录 |

## 包里有什么

```
zhixue-server/
├── 部署教程.md                 ← ⭐ 一步一步照着做
├── Dockerfile                  ← 微信云托管 / 任意容器平台用（已实测可构建运行）
├── start-android-termux.sh     ← 手机一键启动脚本
├── features.json / ads.json / pay.json / version.json   ← 后台可视化编辑，也可直接改文件
├── src/                        服务器源码（Node 18+，nodemailer 可选）
├── admin/                      Web 管理后台（广告位/会员定价/功能开关/版本公告）
├── releases/zhixue-client-v29.apk   ← OTA 安装包（与 version.json 对应）
└── data/                       运行后自动生成 db.json 存数据
```

## 管理后台（V29 大升级）

浏览器打开 `http://服务器地址:8788/admin`：
- **广告位**：全局/开屏/横幅/信息流开关 + 广告位增删改
- **会员定价**：套餐价格、收款码上传、联系邮箱
- **功能开关**：31 项功能逐项控制（展示/需登录/需会员/提示语）
- **版本公告**：OTA 版本号 + 全站公告
- 登录方式：管理员账号，或服务器启动时的 `ADMIN_KEY`（点「用密匙进入」）

## 最短路径（手机 Termux 3 条命令）

```bash
pkg install nodejs unzip -y
termux-setup-storage
cd ~/server/zhixue-server && bash start-android-termux.sh
```

详细步骤、常见问题、云服务器部署 → 看 **`部署教程.md`**。
