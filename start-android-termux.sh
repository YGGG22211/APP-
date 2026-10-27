#!/data/data/com.termux/files/usr/bin/bash
# ============================================================
#  智学后端 · 安卓 Termux 一键启动（手机变服务器）
#  用法：bash start-android-termux.sh
#  端口：8788（被占用时用 PORT=8899 bash start-android-termux.sh）
#  数据：本目录下的 data/db.json（备份就复制整个 data 文件夹）
#  说明：本脚本会「真的确认端口在监听」后才提示成功，避免误以为跑起来了
# ============================================================
cd "$(dirname "$0")" || exit 1

# ---------- 1. 检查 Node.js ----------
if ! command -v node >/dev/null 2>&1; then
    echo ""
    echo "[错误] 没有检测到 Node.js，请先执行："
    echo "       pkg install nodejs -y"
    echo ""
    exit 1
fi
echo "[1/5] Node.js 版本：$(node -v)"

# ---------- 2. 检查端口是否被占用 ----------
PORT="${PORT:-8788}"
if ! node -e "
const net=require('net');
const s=net.createServer();
s.once('error',e=>{
  if(e.code==='EADDRINUSE'){
    console.log('[错误] 端口 $PORT 已被占用。换一个端口再启动：');
    console.log('       PORT=8899 bash start-android-termux.sh');
    console.log('       （然后 App 里地址也要带上新端口 :8899）');
    process.exit(1);
  } else { process.exit(0); }
});
s.listen($PORT,'127.0.0.1',()=>process.exit(0));
"; then
    exit 1
fi
echo "[2/5] 端口 $PORT 可用"

# ---------- 3. 防休眠 ----------
if command -v termux-wake-lock >/dev/null 2>&1; then
    termux-wake-lock 2>/dev/null && echo "[3/5] 已获取唤醒锁，手机休眠不会杀服务器"
else
    echo "[3/5] 未找到 termux-wake-lock（不影响启动）；建议 pkg install termux-api 后重试"
fi

# ---------- 4. 启动 node，并确认「真的在监听」 ----------
IP=$(ip -4 addr show wlan0 2>/dev/null | grep -o 'inet [0-9.]*' | awk '{print $2}')
[ -z "$IP" ] && IP=$(ip -4 addr show 2>/dev/null | grep -o 'inet [0-9.]*' | awk '{print $2}' | grep -v '127.0.0.1' | head -1)
[ -z "$IP" ] && IP=$(ifconfig wlan0 2>/dev/null | grep -o 'inet addr:[0-9.]*' | cut -d: -f2)
[ -z "$IP" ] && IP="<查不到，执行 ifconfig 手动查看>"

echo "[4/5] 正在启动（日志写入 zhixue.log）..."
SERVER_MODE=phone node src/server.js > zhixue.log 2>&1 &
NODE_PID=$!

# 轮询探测端口（最多 12 秒），确认进程真在监听
READY=0
for i in $(seq 1 24); do
    if node -e "const s=require('net').connect($PORT,'127.0.0.1');s.on('connect',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(1))" 2>/dev/null; then
        READY=1; break
    fi
    sleep 0.5
done

if [ "$READY" -ne 1 ]; then
    echo ""
    echo "[失败] 端口 $PORT 始终没有监听 —— 说明 Node 启动崩溃了（不是没装 Node）。"
    echo "最近日志（看这里找原因）："
    echo "------------------------------------------------------------"
    tail -n 15 zhixue.log
    echo "------------------------------------------------------------"
    kill "$NODE_PID" 2>/dev/null
    exit 1
fi

# ---------- 5. 自检：状态页是否真返回 ----------
if node -e "const http=require('http');http.get('http://127.0.0.1:$PORT/',r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>process.exit(d.includes('服务器运行中')?0:1))}).on('error',()=>process.exit(1))" 2>/dev/null; then
    SELF="✅ 状态页返回正常（浏览器能看到紫色「服务器运行中」）"
else
    SELF="⚠️ 端口已监听，但状态页内容异常，可先尝试浏览器直接访问"
fi

echo "[5/5] 自检完成"
echo ""
echo "============================================================"
echo "  ✅ 服务器已确认在运行（端口 $PORT 真实监听）"
echo "------------------------------------------------------------"
echo "  App 装在本机 → 服务器地址填：  http://127.0.0.1:$PORT"
echo "  App 在别的手机/电脑 → 填：     http://$IP:$PORT"
echo "  浏览器验证 → 打开：            http://127.0.0.1:$PORT"
echo "  管理后台 → 打开：              http://127.0.0.1:$PORT/admin"
echo "  自检结果 → $SELF"
echo "------------------------------------------------------------"
echo "  ⚠️ 浏览器一直转圈？按顺序排查："
echo "     ① 地址必须完整输入 http://127.0.0.1:$PORT（别用 localhost，别少 http://）"
echo "     ② 别用夸克/UC/QQ浏览器（云加速会把请求发到云端，本机地址必转圈）"
echo "        → 用 Chrome、Edge 或系统自带浏览器"
echo "     ③ 夸克/UC 一定要用的话：设置里关闭【云加速/极速模式】再试"
echo "------------------------------------------------------------"
echo "  ⚠️ iQOO / OriginOS 用户必做（否则锁屏后【一直转圈进不去】）："
echo "     ① 多任务卡片【下拉锁定】  ② 设置→电池→后台耗电管理→Termux【允许后台高耗电】"
echo "     ③ 设置→WLAN→锁屏后保持 WLAN 连接【始终】"
echo "  保持 Termux 在前台常驻；停止服务器：按 Ctrl+C（数据自动保存）"
echo "============================================================"

# 前台挂起，保持 Termux 窗口常驻（划掉窗口 = 服务器停止）
wait "$NODE_PID"
