// scripts/verify.mjs — 一次性复核流水线（成功以退出码 0 结束，失败非零）：
//   1) 针对本题运行有限域与纠错规则测试（node --test）；
//   2) 构建静态页面到 dist/；
//   3) 启动静态服务器，对健康页 /health 与可纠正样例作 HTTP 冒烟，
//      并在进程内重新执行纠错规则，确认样例证据闭合。
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeBch } from '../src/bch.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8090);

function run(cmd, args, options = {}) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, ...(options.env || {}) },
    });
    p.on('error', rej);
    p.on('exit', (code) => (code === 0 ? res() : rej(new Error(`${cmd} ${args.join(' ')} 退出码 ${code}`))));
  });
}

async function waitForHealth(url, deadline) {
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(url);
      if (resp.ok) return;
      lastErr = new Error(`HTTP ${resp.status}`);
    } catch (e) {
      lastErr = e;
    }
    await sleep(200);
  }
  throw new Error(`服务器未在限定时间内就绪：${lastErr?.message}`);
}

async function main() {
  console.log('=== 步骤 1/3：有限域与 BCH 纠错规则测试 ===');
  await run(process.execPath, ['--test', 'test/']);

  console.log('=== 步骤 2/3：构建静态页面 ===');
  await run(process.execPath, ['scripts/build.mjs']);

  console.log('=== 步骤 3/3：HTTP 冒烟（健康页 + 可纠正样例） ===');
  // 若提供 WEB_BASE（如 Compose 中指向 web 服务），直接对该服务冒烟；
  // 否则在进程内自起一台静态服务器完成冒烟。
  const externalBase = process.env.WEB_BASE ? process.env.WEB_BASE.replace(/\/$/, '') : null;
  const ownServer = externalBase
    ? null
    : spawn(process.execPath, ['scripts/server.js'], {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'inherit'],
        env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
      });
  const base = externalBase || `http://127.0.0.1:${PORT}`;
  let failed = null;
  let shuttingDown = false;
  try {
    if (ownServer) {
      ownServer.on('exit', (code) => {
        if (!shuttingDown && code !== 0 && failed === null) {
          failed = new Error(`服务器提前退出，码 ${code}`);
        }
      });
    }
    await waitForHealth(`${base}/health`, Date.now() + 15000);

    // 健康页冒烟
    const hResp = await fetch(`${base}/health`);
    if (hResp.status !== 200) throw new Error(`/health 状态码 ${hResp.status}`);
    const health = await hResp.json();
    if (health.status !== 'ok') throw new Error('/health 返回体 status 非 ok');
    console.log('[smoke] /health 200 OK ->', JSON.stringify(health));

    // 页面与 Worker 资源
    for (const path of ['/', '/app.js', '/worker.js', '/lib/gf.js', '/lib/bch.js']) {
      const r = await fetch(base + path);
      if (r.status !== 200) throw new Error(`资源 ${path} 状态码 ${r.status}`);
      console.log(`[smoke] GET ${path} 200 (${(await r.arrayBuffer()).byteLength} 字节)`);
    }

    // 可纠正样例冒烟：经 HTTP 取得样例，再在本地执行同一套纠错规则复核
    const sResp = await fetch(`${base}/sample.json`);
    if (sResp.status !== 200) throw new Error(`/sample.json 状态码 ${sResp.status}`);
    const sample = await sResp.json();
    const result = analyzeBch(sample.input);
    if (result.errorCount !== sample.expect.errorCount) {
      throw new Error(`样例错误数不符：期望 ${sample.expect.errorCount}，实得 ${result.errorCount}`);
    }
    if (result.generator.bits !== sample.expect.generatorBits) {
      throw new Error('样例生成多项式与构建期记录不一致。');
    }
    if (result.corrected !== sample.expect.corrected) {
      throw new Error('样例纠正码字与构建期记录不一致。');
    }
    if (result.roots.length !== result.locator.degree) {
      throw new Error('样例定位证据不闭合：根数 ≠ deg(Λ)。');
    }
    console.log(
      `[smoke] /sample.json 200 OK -> 纠正 ${result.errorCount} 位，g=${result.generator.text}`
    );
    console.log(`[smoke] 纠正码字：${result.corrected}`);
    console.log('\n全部复核通过：测试、构建、健康页与可纠正样例冒烟均闭合。');
  } catch (e) {
    failed = e;
  } finally {
    if (ownServer) {
      shuttingDown = true;
      ownServer.kill('SIGTERM');
      await once(ownServer, 'exit').catch(() => {});
    }
  }
  if (failed) throw failed;
}

main().catch((e) => {
  console.error('\nverify 失败：', e.message);
  process.exit(1);
});
