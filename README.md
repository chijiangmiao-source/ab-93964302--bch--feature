# 窄义二进制 BCH 码字离线复核

受扰星载遥测链路只送来硬判决比特。本工具让地面工程师在浏览器里**离线**确认一段码字能否按
**窄义二进制本原 BCH（narrow-sense primitive binary BCH）**规则被纠正，并展示全部证据；
超出纠错能力或证据无法闭合时，明确指出失败原因，绝不把损坏伪装成正常数据。

所有运算在浏览器 **Web Worker** 内完成，不发起任何网络请求；Worker 与 Node 测试共用
`src/` 下同一份零依赖有限域/BCH 核心代码。

## 复核规则（与实现严格对应）

1. **先验证本原多项式**：输入比特串长度必须为 m+1、首末位为 1；先用 Rabin 判据验证其在
   GF(2) 上不可约（`f | x^(2^m)−x`，且对 m 的每个素因子 q，`gcd(f, x^(2^(m/q))−x)=1`），
   再验证 α=x 的乘法阶恰为 2^m−1。任一条不满足直接失败，不构造任何后续证据。
2. **构造生成多项式**：合并 α 的连续根 α, α², …, α^(2t) 所在的二倍循环陪集，
   `g(x) = lcm(M_1,…,M_{2t})`，并校验 `1 ≤ deg(g) ≤ mt`、信息位 k=n−deg(g)>0。
3. **同一位序**完成综合症 `S_j = r(α^j)`（Horner，j=1…2t）、
   Berlekamp–Massey 定位多项式 Λ(x)、Chien 搜索 `Λ(α^(−i))=0`（i=0…n−1）。
   输入串最左字符对应 x^(n−1)。
4. **仅当** Chien 找到的根数等于 deg(Λ)、deg(Λ) ≤ t，**且**翻转定位比特后重算的
   2t 个综合症全部为零，才给出“可纠正”结论。
5. 输入位串非法、参数组合非法、生成多项式次数不满足有效码长、定位证据不闭合时，
   页面显示稳定的中文失败原因，并清除上一次的成功证据。

页面依次展示：生成多项式（含各陪集与最小多项式）、综合症表、错误定位多项式、
根对应的比特位置（幂次 x^i 与串内位置）、纠正后的码字（错误位高亮）。

## 目录结构

```
src/gf.js          GF(2)[x] / GF(2^m)：不可约与本原判据、指数对数表
src/bch.js         陪集、生成多项式、综合症、BM、Chien、闭合裁决（analyzeBch）
web/index.html     静态页面
web/app.js         页面交互与证据渲染（失败即清除旧证据）
web/worker.js      module Worker，调用同一份 src/ 核心
scripts/build.mjs  构建 dist/（复制页面与核心、生成可纠正样例 sample.json）
scripts/server.js  零依赖静态服务器，暴露 /health
scripts/verify.mjs 单次复核：测试 → 构建 → HTTP 冒烟 → 退出码
test/              node --test 有限域与纠错规则测试（20 个）
Dockerfile         node:20-alpine，零依赖，构建期生成 dist/
docker-compose.yml web（长驻 + 健康检查）与 verify（单次）
```

## Docker Compose 启动

```bash
# 默认宿主机端口 8080：
docker compose up --build -d web
# 浏览器打开 http://localhost:8080 ，健康检查 http://localhost:8080/health

# 自定义宿主机端口：
HOST_PORT=9090 docker compose up --build -d web
```

`/health` 返回 `200 {"status":"ok",...}`，Compose 也据此配置了容器健康检查。

## 单次 verify 服务

按题意，`verify` 服务**运行一次即退出**（成功退出码 0，失败非零），依次：

1. 运行有限域与 BCH 纠错规则测试（`node --test test/`，20 个用例，含本原性判据、
   `g | x^n−1` 与 `g(α^j)=0` 的独立交叉校验、系统编码后随机注入 1…t 个错误必须纠正、
   超能力损坏必须拒绝或纠为另一个合法码字）；
2. 构建静态页面到 `dist/`；
3. 等待 `web` 健康后，对 `/health`、页面/Worker 资源与构建期生成的**可纠正样例**
   `/sample.json` 作 HTTP 冒烟，并在进程内用同一套纠错规则复核样例证据闭合。

```bash
docker compose build
docker compose run --rm verify      # 等待 web 健康后对其冒烟，结束即退出
```

## 无 Docker 时的本地运行（Node ≥ 20，零依赖）

```bash
npm test            # 仅跑有限域与纠错规则测试
npm run build       # 生成 dist/
npm start           # 静态服务（PORT 环境变量可调端口）
npm run verify      # 本地完整单次复核（内部自起服务冒烟）
```

## 页面使用

填写域阶数 m（2–20）、本原多项式比特串（如 m=4 的 `10011` = x⁴+x+1）、
纠错能力 t、长度恰为 2^m−1 的接收码字，点击「复核」查看五段证据；
「清空草稿和结论」会清空全部输入并移除成功/失败结论。
