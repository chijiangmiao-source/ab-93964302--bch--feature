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
import { analyzeBch, analyzeBchFrame } from '../src/bch.js';

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
    // 连续帧样例冒烟：经 HTTP 取得样例，在本地执行同一套逐块复核规则
    const fResp = await fetch(`${base}/frame-sample.json`);
    if (fResp.status !== 200) throw new Error(`/frame-sample.json 状态码 ${fResp.status}`);
    const frameSample = await fResp.json();

    // 场景一：合法连续帧，整帧可采用
    const good = analyzeBchFrame(frameSample.goodFrame.input);
    const ge = frameSample.goodFrame.expect;
    if (good.allCorrectable !== ge.allCorrectable) {
      throw new Error('连续帧样例：整帧应可采用。');
    }
    if (good.blockCount !== ge.blockCount || good.n !== ge.n) {
      throw new Error('连续帧样例：块数或码长与构建期记录不一致。');
    }
    if (good.correctedFrame !== ge.correctedFrame) {
      throw new Error('连续帧样例：纠正整帧与构建期记录不一致。');
    }
    const gotCounts = good.blocks.map((b) => b.result.errorCount);
    if (JSON.stringify(gotCounts) !== JSON.stringify(ge.errorCounts)) {
      throw new Error(`连续帧样例：逐块错误数不符，期望 ${ge.errorCounts}，实得 ${gotCounts}。`);
    }
    for (const b of good.blocks) {
      if (!b.ok || b.result.roots.length !== b.result.locator.degree) {
        throw new Error(`连续帧样例：第 ${b.ordinal} 块定位证据不闭合。`);
      }
    }
    console.log(
      `[smoke] /frame-sample.json goodFrame 200 OK -> ${good.blockCount} 块全部可纠正，逐块错误数 [${gotCounts.join(', ')}]`
    );

    // 场景二：某块超出能力 / 证据不闭合，其余块保留，整帧拒绝
    const bad = analyzeBchFrame(frameSample.rejectedFrame.input);
    const be = frameSample.rejectedFrame.expect;
    if (bad.allCorrectable !== be.allCorrectable || bad.correctedFrame !== undefined) {
      throw new Error('连续帧样例：含坏块时必须拒绝整帧采用且不给出纠正整帧。');
    }
    const failedOrdinals = bad.blocks.filter((x) => !x.ok).map((x) => x.ordinal);
    if (JSON.stringify(failedOrdinals) !== JSON.stringify(be.failedOrdinals)) {
      throw new Error(`连续帧样例：失败块不符，期望 ${be.failedOrdinals}，实得 ${failedOrdinals}。`);
    }
    if (bad.blocks[0].result.corrected !== be.correctedBlock0) {
      throw new Error('连续帧样例：坏块之前的其余块结果未保留。');
    }
    if (bad.blocks[2].result.corrected !== be.correctedBlock2) {
      throw new Error('连续帧样例：坏块之后的其余块结果未保留。');
    }
    if (!/超过纠错能力|无法闭合/.test(bad.blocks[1].reason)) {
      throw new Error('连续帧样例：坏块失败原因未指明超出能力或证据不闭合。');
    }
    if (bad.frame !== frameSample.rejectedFrame.input.frameStr) {
      throw new Error('连续帧样例：原始整帧未按输入回显。');
    }
    console.log(
      `[smoke] /frame-sample.json rejectedFrame 200 OK -> 第 ${failedOrdinals.join('、')} 块失败，其余块保留，整帧拒绝采用`
    );
    console.log('\n全部复核通过：测试、构建、健康页、单块与连续帧样例冒烟均闭合。');
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
