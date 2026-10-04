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
  const { analyzeBch, buildGenerator } = await import('../src/bch.js');
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
}

main().catch((e) => {
  console.error('[build] 失败：', e.message);
  process.exit(1);
});
