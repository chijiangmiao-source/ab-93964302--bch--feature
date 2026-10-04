// scripts/verify.mjs — 一次性复核流水线（成功以退出码 0 结束，失败非零）：
//   1) 针对本题运行有限域与纠错规则测试（node --test，含连续整帧批量场景）；
//   2) 构建静态页面到 dist/；
//   3) 启动静态服务器，对健康页 /health、页面资源与样例作 HTTP 冒烟：
//      单码字样例与连续整帧样例都在进程内用同一套纠错规则复核证据闭合，
//      并确认页面确实提供批量模式入口（模式切换、块数输入、整帧结果区）。
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeBch, analyzeFrame } from '../src/bch.js';

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
  console.log('=== 步骤 1/3：有限域与 BCH 纠错规则测试（含连续整帧批量场景） ===');
  await run(process.execPath, ['--test', 'test/']);

  console.log('=== 步骤 2/3：构建静态页面 ===');
  await run(process.execPath, ['scripts/build.mjs']);

  console.log('=== 步骤 3/3：HTTP 冒烟（健康页 + 页面批量入口 + 单码字/整帧样例） ===');
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
    const resources = ['/', '/app.js', '/worker.js', '/lib/gf.js', '/lib/bch.js'];
    const bodies = {};
    for (const path of resources) {
      const r = await fetch(base + path);
      if (r.status !== 200) throw new Error(`资源 ${path} 状态码 ${r.status}`);
      bodies[path] = await r.text();
      console.log(`[smoke] GET ${path} 200 (${Buffer.byteLength(bodies[path])} 字节)`);
    }

    // 页面可用性：批量模式入口与整帧结果区必须出现在所服务的页面/脚本中
    const htmlChecks = ['name="mode"', 'value="frame"', 'id="blk-count"', 'id="frame-bits"',
      'id="frame-result"', 'id="frame-blocks"', 'id="frame-concat"'];
    for (const needle of htmlChecks) {
      if (!bodies['/'].includes(needle)) {
        throw new Error(`页面缺少批量模式元素：${needle}`);
      }
    }
    if (!bodies['/app.js'].includes('analyzeFrame')) {
      throw new Error('app.js 未接入 analyzeFrame 批量复核流程。');
    }
    if (!bodies['/worker.js'].includes('analyzeFrame')) {
      throw new Error('worker.js 未导出 analyzeFrame 批量复核入口。');
    }
    console.log('[smoke] 页面批量模式入口齐全（模式切换 / 块数 / 连续比特串 / 整帧结果区）');

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

    // 连续整帧样例冒烟：经 HTTP 取得样例，逐块复核并确认整帧可采用
    const fResp = await fetch(`${base}/sample-frame.json`);
    if (fResp.status !== 200) throw new Error(`/sample-frame.json 状态码 ${fResp.status}`);
    const frameSample = await fResp.json();
    const frame = analyzeFrame(frameSample.input);
    if (!frame.adopted) throw new Error('整帧样例未被采用：存在未闭合的块。');
    if (frame.blocks.length !== frameSample.input.blockCount) {
      throw new Error(`整帧块数不符：期望 ${frameSample.input.blockCount}，实得 ${frame.blocks.length}`);
    }
    if (frame.totalErrors !== frameSample.expect.totalErrors) {
      throw new Error(`整帧错误总数不符：期望 ${frameSample.expect.totalErrors}，实得 ${frame.totalErrors}`);
    }
    if (frame.frameCorrected !== frameSample.expect.frameCorrected) {
      throw new Error('整帧纠正结果与构建期记录不一致。');
    }
    frame.blocks.forEach((b, i) => {
      if (!b.ok) throw new Error(`第 ${i + 1} 块未闭合：${b.error}`);
      if (b.result.roots.length !== b.result.locator.degree) {
        throw new Error(`第 ${i + 1} 块定位证据不闭合：根数 ≠ deg(Λ)。`);
      }
      if (b.result.errorCount !== frameSample.expect.blockErrorCounts[i]) {
        throw new Error(`第 ${i + 1} 块错误数不符。`);
      }
    });
    const gotFrameIdx = frame.blocks.map((b) => b.result.roots.map((x) => x.frameIndex1));
    if (JSON.stringify(gotFrameIdx) !== JSON.stringify(frameSample.expect.blockErrorFrameIndexes1)) {
      throw new Error('整帧错误位置（整帧 1 基）与构建期记录不一致。');
    }
    console.log(
      `[smoke] /sample-frame.json 200 OK -> ${frame.params.blockCount} 块整帧可采用，` +
      `错误分布 ${frameSample.expect.blockErrorCounts.join('/')}`
    );
    console.log(`[smoke] 纠正整帧：${frame.frameCorrected}`);
    console.log('\n全部复核通过：测试、构建、健康页、批量入口与单码字/整帧样例冒烟均闭合。');
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
