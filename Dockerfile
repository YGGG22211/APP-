# 智学后端 · 微信云托管 / GitHub / 通用容器镜像
# 微信云托管要求：进程必须监听环境变量 PORT 指定的端口（本服务器已支持）
FROM node:18-alpine

WORKDIR /app

# 先装依赖（nodemailer 可选，用于真实发验证码邮件）
COPY package.json ./
RUN npm install --omit=dev

# 拷贝其余全部文件（平铺版：所有 js 在根目录）
# releases/ 目录可选：有则支持 App 内 OTA 更新下载，没有不影响服务运行
COPY . .

# 数据目录（容器内可写；云托管重建容器会清空，重要数据请挂载 CFS）
RUN mkdir -p data uploads
ENV NODE_ENV=production

# 微信云托管会注入 PORT（默认 8080），服务器代码读取该变量监听
EXPOSE 8080
CMD ["node", "server.js"]
