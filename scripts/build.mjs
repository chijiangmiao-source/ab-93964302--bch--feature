// scripts/build.mjs — 构建静态页面到 dist/：
//   1) 复制 web/ 全部资源；
//   2) 复制共享核心 src/*.js 到 dist/lib/（Worker 以 ./lib/bch.js 引入）；
//   3) 用核心库生成一个“可纠正样例” sample.json，供 verify HTTP 冒烟使用。
import { rm, mkdir, cp, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DIST = resolve(ROOT, 'dist');

async function main() {
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });
  await cp(resolve(ROOT, 'web'), DIST, { recursive: true });
  await mkdir(resolve(DIST, 'lib'), { recursive: true });
  await cp(resolve(ROOT, 'src', 'gf.js'), resolve(DIST, 'lib', 'gf.js'));
  await cp(resolve(ROOT, 'src', 'bch.js'), resolve(DIST, 'lib', 'bch.js'));

  // 生成可纠正样例：(15,7) BCH，t=2，对随机选定信息做系统编码后注入两个硬错误。
  const { analyzeBch, analyzeBchFrame, buildGenerator } = await import('../src/bch.js');
  const { makeField, validatePrimitivePolynomial } = await import('../src/gf.js');

  function bMul(a, b) {
    let r = 0n;
    while (b) { if (b & 1n) r ^= a; a <<= 1n; b >>= 1n; }
    return r;
  }
  function bMod(a, m) {
    const dm = m.toString(2).length - 1;
    let r = a;
    let dr = r === 0n ? -1 : r.toString(2).length - 1;
    while (dr >= dm) { r ^= m << BigInt(dr - dm); dr = r === 0n ? -1 : r.toString(2).length - 1; }
    return r;
  }

  const m = 4;
  const polyStr = '10011';
  const t = 2;
  const field = makeField(m, validatePrimitivePolynomial(m, polyStr));
  const gen = buildGenerator(field, m, t);
  // 系统编码 c = u·x^(n−k) + (u·x^(n−k) mod g)
  const message = 0b1101001;
  const shifted = BigInt(message) << BigInt(gen.n - gen.k);
  const codeword = (shifted ^ bMod(shifted, gen.g)).toString(2).padStart(gen.n, '0');
  // 翻转串内 0 基位置 2、9（对应 x^12、x^5）
  const cwArr = codeword.split('');
  for (const p of [2, 9]) cwArr[p] = cwArr[p] === '0' ? '1' : '0';
  const sampleInput = { m, polyStr, t, rStr: cwArr.join('') };
  const result = analyzeBch(sampleInput);
  if (result.errorCount !== 2 || !result.roots || result.roots.length !== result.locator.degree) {
    throw new Error('构建失败：内置可纠正样例未按预期闭合。');
  }
  await writeFile(
    resolve(DIST, 'sample.json'),
    JSON.stringify(
      {
        description: 'verify 冒烟样例：(15,7,2) 窄义二进制 BCH，两个硬判决错误',
        input: sampleInput,
        expect: {
          errorCount: 2,
          generatorBits: result.generator.bits,
          corrected: result.corrected,
          errorStringIndexes1: result.roots.map((x) => x.stringIndex1),
        },
      },
      null,
      2
    ),
    'utf-8'
  );

  console.log('[build] dist/ 就绪：页面 + Worker + 共享核心库 + sample.json');

  // 连续帧样例：同一组 BCH 参数下 3 个等长码字拼成的连续比特串。
  //   场景 frame：三块分别含 1 / 0 / 2 个错误，整帧应可采用；
  //   场景 frameRejected：第 2 块注入 t+1=3 个错误（该模式必被拒绝），
  //                       其余块仍可纠正，但整帧必须拒绝采用。
  const sys = (g, msgBits) => {
    const shifted = BigInt(msgBits) << BigInt(g.n - g.k);
    return (shifted ^ bMod(shifted, g.g)).toString(2).padStart(g.n, '0');
  };
  const flipAt = (str, positions) => {
    const a = str.split('');
    for (const p of positions) a[p] = a[p] === '0' ? '1' : '0';
    return a.join('');
  };
  const fc0 = sys(gen, 0b1101001);
  const fc1 = sys(gen, 0b0001110);
  const fc2 = sys(gen, 0b1010101);
  const fb0 = flipAt(fc0, [2]);
  const fb1 = fc1;
  const fb2 = flipAt(fc2, [0, 13]);
  const goodFrameInput = {
    m, polyStr, t, blockCount: 3, frameStr: fb0 + fb1 + fb2,
  };
  const goodFrame = analyzeBchFrame(goodFrameInput);
  if (!goodFrame.allCorrectable || goodFrame.correctedFrame !== fc0 + fc1 + fc2) {
    throw new Error('构建失败：连续帧样例未按预期闭合。');
  }

  // 与单块测试相同的三错模式（[1,5,11]）在 (15,7,t=2) 下必须被拒绝
  const rc1 = flipAt(fc1, [1, 5, 11]);
  const rejectedFrameInput = {
    m, polyStr, t, blockCount: 3, frameStr: fb0 + rc1 + fb2,
  };
  const rejectedFrame = analyzeBchFrame(rejectedFrameInput);
  if (rejectedFrame.allCorrectable || rejectedFrame.correctedFrame !== undefined) {
    throw new Error('构建失败：含坏块的连续帧样例未被拒绝。');
  }
  if (!rejectedFrame.blocks[0].ok || !rejectedFrame.blocks[2].ok || rejectedFrame.blocks[1].ok) {
    throw new Error('构建失败：连续帧坏块样例的逐块保留结果不符合预期。');
  }

  await writeFile(
    resolve(DIST, 'frame-sample.json'),
    JSON.stringify(
      {
        description:
          'verify 连续帧冒烟样例：3 × (15,7,2) 窄义二进制 BCH；goodFrame 整帧可采用，rejectedFrame 第 2 块失败、整帧拒绝',
        goodFrame: {
          input: goodFrameInput,
          expect: {
            allCorrectable: true,
            blockCount: 3,
            n: gen.n,
            errorCounts: [1, 0, 2],
            correctedFrame: fc0 + fc1 + fc2,
          },
        },
        rejectedFrame: {
          input: rejectedFrameInput,
          expect: {
            allCorrectable: false,
            failedOrdinals: [2],
            correctedBlock0: fc0,
            correctedBlock2: fc2,
          },
        },
      },
      null,
      2
    ),
    'utf-8'
  );
  console.log('[build] frame-sample.json 就绪：连续帧可采用 / 拒绝两种场景');
}

main().catch((e) => {
  console.error('[build] 失败：', e.message);
  process.exit(1);
});
