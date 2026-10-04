# 零依赖 Node 20 镜像：同一镜像承载 web（长驻静态服务）与 verify（单次复核）。
FROM node:20-alpine

WORKDIR /app

# 先复制清单与源码（无第三方依赖）
COPY package.json ./
COPY src ./src
COPY web ./web
COPY scripts ./scripts
COPY test ./test

# 构建期即生成静态产物 dist/，web 可直接启动
RUN node scripts/build.mjs

ENV NODE_ENV=production
EXPOSE 8080

# 默认启动静态页面服务；compose 的 verify 服务会覆盖为单次复核命令。
CMD ["node", "scripts/server.js"]
