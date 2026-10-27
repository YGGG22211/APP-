# 智学 · API 前后端兼容说明（V17）

> 你问的「如果后端改了，前端 App 还能连上吗」。
> 答案：**能。** 本版所有接口都遵循「只加字段、不改结构」的向后兼容原则，
> 旧 App 连新服务器、新 App 连旧服务器都不会崩。

---

## 一、兼容规则（铁律）

1. **响应只增不改**：任何 JSON 字段新增都带默认值，老客户端忽略未知字段即可。
   - 例：`/api/health` 新增 `publicUrl` / `minClientCode` / `latestVersion`，老 App 不读也无害。
2. **客户端解析全 null 安全**：`lib/core/api_client.dart` 所有取值都做 `?? 默认值` 与类型判断，
   服务器多返回/少返回字段都不会抛异常。
3. **版本协商走独立接口**：`/app/compat` 告诉客户端「最低可运行 code」与「最新 code」，
   由客户端决定是否提示更新，**不强制旧版不可用**。
4. **新接口默认免登录**：`/app/latest`、`/app/compat`、`/ads/config` 都 `needAuth:false`，
   即使旧鉴权逻辑变了，这些「发现/更新/广告」接口照样能拉到。

---

## 二、版本协商接口

### `GET /api/health`（免登录）
```json
{ "code": 0, "data": {
    "status": "up", "mode": "pc", "port": 8788,
    "publicUrl": "", "minClientCode": 12, "latestVersion": "V17"
} }
```
- `minClientCode`：服务端要求的最低客户端 code，低于它的客户端应提示升级。
- `publicUrl`：若设了 `PUBLIC_URL` 环境变量（穿透/云服务器），这里返回公网地址，
  App 的 OTA 下载地址自动切换为公网，不用改客户端。

### `GET /app/compat`（免登录）
```json
{ "code": 0, "data": {
    "minClientCode": 12, "latestCode": 17, "latestVersion": "V17",
    "message": "建议更新到最新版以获得完整体验"
} }
```

### `GET /app/latest`（免登录，OTA 用）
```json
{ "code": 0, "data": {
    "version": "V17", "code": 17,
    "apk": "/releases/lingxi-client-v17.apk",
    "minCode": 12, "force": false,
    "notes": "…", "size": 0, "publicUrl": ""
} }
```
- `code`：比本地 `appBuildCode`(=17) 大 → 有新版本。
- `apk`：相对路径走当前服务器（含 `publicUrl` 自动切换）；也可填完整 `https://` CDN 地址。
- `force`：`true` 时更新框不可跳过。

---

## 三、App 端是怎么「向前兼容」的

| 场景 | 行为 |
|---|---|
| 新服务器，旧 App（code<17） | 旧 App 读得到它认识的字段，新字段忽略；`minClientCode` 触发「建议更新」提示，但不阻断使用 |
| 旧服务器，新 App（code=17） | `appLatest().code <= appBuildCode` → 判定「已是最新」，不弹更新；其它字段缺失用默认值兜底 |
| 服务器连不上 | `/app/latest`、`/ads/config` 走 catch 兜底：广告用内置、更新静默忽略，**不弹错** |
| 中途服务器字段调整 | `api_client.dart` 全程 `as int?` / `as String?` / `?? `，绝不因字段缺失崩溃 |

---

## 四、给开发者的「改后端不炸客户端」清单

- ✅ 新增字段 → 随便加，客户端忽略未知字段。
- ❌ 删除/重命名字段 → 会破坏旧客户端，需先保留旧字段一两个版本。
- ❌ 改字段类型（如 `code` 从 int 变 string）→ 客户端已按类型解析，会兜底但语义错。
- ✅ 加新接口 → 记得 `route('GET','/x', handler, false)` 标明 `needAuth:false`（若希望免登录）。
- ✅ 改鉴权方式 → 保持 `/app/latest`、`/ads/config`、`/api/health` 免登录，更新/广告永远可达。

---

## 五、OTA 升级怎么不「签名冲突」

- V17 的 release 构建**沿用 debug 签名**（见 `build.gradle`），
  目的：让已装 v16（debug 签名）的用户**覆盖安装 v17 不报「签名不一致」**，
  从而 App 内一键更新（下载 APK → 系统安装）能成功。
- 若你未来要换正式签名上架应用商店，请**增量发版**或引导用户先卸载旧版，
  否则 OTA 覆盖安装会因签名不同被系统拒绝。
