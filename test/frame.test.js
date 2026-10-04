// test/frame.test.js — 连续整帧批量复核规则测试（node --test）
// 场景：地面工程师一次下传多个等长码字，按当前 m 推导的码长切分，
// 每块走与单码字完全一致的复核流程；任一块不闭合即拒绝整帧采用，但保留其余块证据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeBch, analyzeFrame, buildGenerator, MAX_FRAME_BLOCKS } from '../src/bch.js';
import { makeField, validatePrimitivePolynomial } from '../src/gf.js';

// BigInt GF(2)[x] 模（与实现独立的系统编码交叉校验）
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

function setup(m, bits, t) {
  const f = validatePrimitivePolynomial(m, bits);
  const field = makeField(m, f);
  const gen = buildGenerator(field, m, t);
  return { field, gen };
}

/** 独立系统编码：c = m·x^(n−k) + (m·x^(n−k) mod g)，返回 n 位串（最左 x^(n−1)）。 */
function systematicEncode(field, g, k, mBits) {
  const n = field.n;
  const r = n - k;
  const mx = BigInt(mBits) << BigInt(r);
  return (mx ^ bMod(mx, g)).toString(2).padStart(n, '0');
}

function flip(str, positions) {
  const a = str.split('');
  for (const p of positions) a[p] = a[p] === '0' ? '1' : '0';
  return a.join('');
}

const M = 4;
const POLY = '10011';
const T = 2;
const N = 15;

test('合法连续帧：逐块闭合、整帧可采用，错误位置与纠正整帧正确', () => {
  const { field, gen } = setup(M, POLY, T);
  const clean = [
    systematicEncode(field, gen.g, gen.k, 0b1011001),
    systematicEncode(field, gen.g, gen.k, 0b0110110),
    systematicEncode(field, gen.g, gen.k, 0b1111111),
  ];
  const received = [
    flip(clean[0], [1, 12]), // 第 1 块 2 个错误
    clean[1], // 第 2 块干净
    flip(clean[2], [7]), // 第 3 块 1 个错误
  ];
  const fr = analyzeFrame({ m: M, polyStr: POLY, t: T, blockCount: 3, frameStr: received.join('') });

  assert.equal(fr.adopted, true);
  assert.equal(fr.params.blockCount, 3);
  assert.equal(fr.params.totalLength, 3 * N);
  assert.equal(fr.totalErrors, 3);
  assert.equal(fr.blocks.length, 3);
  assert.equal(fr.frameReceived, received.join(''));
  assert.equal(fr.frameCorrected, clean.join(''));
  assert.match(fr.conclusion, /整帧可采用/);

  // 按块序：每块都有可纠正结论、综合症摘要与串内错误位置
  assert.deepEqual(fr.blocks.map((b) => b.result.errorCount), [2, 0, 1]);
  for (const [i, blk] of fr.blocks.entries()) {
    assert.equal(blk.ok, true);
    assert.equal(blk.index, i);
    assert.equal(blk.result.received, received[i]);
    assert.equal(blk.result.corrected, clean[i]);
    assert.equal(blk.result.syndromes.length, 2 * T);
    assert.equal(blk.result.roots.length, blk.result.locator.degree);
  }
  // 第 1 块：块内 1 基位置 2、13；整帧 1 基位置同为 2、13
  const b0pos = fr.blocks[0].result.roots.map((x) => x.stringIndex1).sort((a, b) => a - b);
  assert.deepEqual(b0pos, [2, 13]);
  const b0frame = fr.blocks[0].result.roots.map((x) => x.frameIndex1).sort((a, b) => a - b);
  assert.deepEqual(b0frame, [2, 13]);
  // 第 3 块：块内第 8 位 = 整帧第 2*15+8 = 38 位
  assert.equal(fr.blocks[2].result.roots[0].stringIndex1, 8);
  assert.equal(fr.blocks[2].result.roots[0].frameIndex1, 2 * N + 8);
  // 干净块：综合症全零、无错误位置
  assert.ok(fr.blocks[1].result.syndromes.every((s) => s.value === 0));
  assert.equal(fr.blocks[1].result.roots.length, 0);
});

test('全部块零错误：整帧可采用且无需纠正', () => {
  const { field, gen } = setup(M, POLY, T);
  const clean = [
    systematicEncode(field, gen.g, gen.k, 0b0000001),
    systematicEncode(field, gen.g, gen.k, 0b1010101),
  ];
  const fr = analyzeFrame({ m: M, polyStr: POLY, t: T, blockCount: 2, frameStr: clean.join('') });
  assert.equal(fr.adopted, true);
  assert.equal(fr.totalErrors, 0);
  assert.equal(fr.frameCorrected, clean.join(''));
  assert.match(fr.conclusion, /无需纠正/);
});

test('某块超出纠错能力：保留其余块结果并明确拒绝整帧采用', () => {
  const { field, gen } = setup(M, POLY, T);
  const good1 = systematicEncode(field, gen.g, gen.k, 0b1011001);
  const good2 = systematicEncode(field, gen.g, gen.k, 0b0101010);
  // 已知 (15,7,2) 下该三错模式必然被拒绝（BM 超次或 Chien 不闭合）
  const bad = flip(systematicEncode(field, gen.g, gen.k, 0b1011001), [1, 5, 11]);
  assert.throws(() => analyzeBch({ m: M, polyStr: POLY, t: T, rStr: bad }), /超过纠错能力|无法闭合/);

  const fr = analyzeFrame({
    m: M, polyStr: POLY, t: T, blockCount: 3, frameStr: good1 + bad + good2,
  });
  assert.equal(fr.adopted, false);
  assert.equal(fr.frameCorrected, null);
  assert.match(fr.conclusion, /拒绝整帧采用/);
  assert.match(fr.conclusion, /第 2 块/);
  // 其余块结果完整保留
  assert.equal(fr.blocks[0].ok, true);
  assert.equal(fr.blocks[0].result.corrected, good1);
  assert.equal(fr.blocks[2].ok, true);
  assert.equal(fr.blocks[2].result.corrected, good2);
  // 失败块：带中文原因与原始接收串，不伪装纠正
  assert.equal(fr.blocks[1].ok, false);
  assert.match(fr.blocks[1].error, /超过纠错能力|无法闭合/);
  assert.equal(fr.blocks[1].received, bad);
});

test('失败块不阻断后续块：坏块在帧首时其余块照常闭合', () => {
  const { field, gen } = setup(M, POLY, T);
  const bad = flip(systematicEncode(field, gen.g, gen.k, 0b1011001), [1, 5, 11]);
  const good = systematicEncode(field, gen.g, gen.k, 0b0111100);
  const fr = analyzeFrame({ m: M, polyStr: POLY, t: T, blockCount: 2, frameStr: bad + good });
  assert.equal(fr.adopted, false);
  assert.equal(fr.blocks[0].ok, false);
  assert.equal(fr.blocks[1].ok, true);
  assert.equal(fr.blocks[1].result.corrected, good);
});

test('块数非法：非整数、越界、空缺都被准确指出', () => {
  const bits = '0'.repeat(2 * N);
  for (const bc of [0, -1, 2.5, 'abc', '', Number.NaN, MAX_FRAME_BLOCKS + 1]) {
    assert.throws(
      () => analyzeFrame({ m: M, polyStr: POLY, t: T, blockCount: bc, frameStr: bits }),
      /块数非法/,
      `blockCount=${String(bc)}`
    );
  }
});

test('整帧总长度非法：指出期望与实际长度', () => {
  assert.throws(
    () => analyzeFrame({ m: M, polyStr: POLY, t: T, blockCount: 3, frameStr: '0'.repeat(3 * N - 1) }),
    /总长度非法.*45.*44/
  );
  assert.throws(
    () => analyzeFrame({ m: M, polyStr: POLY, t: T, blockCount: 2, frameStr: '0'.repeat(3 * N) }),
    /总长度非法.*30.*45/
  );
});

test('整帧字符非法与共享参数非法：在任何块结论之前抛出', () => {
  const bits = '0'.repeat(2 * N);
  assert.throws(
    () => analyzeFrame({ m: M, polyStr: POLY, t: T, blockCount: 2, frameStr: '0'.repeat(N) + 'x' + '0'.repeat(N - 1) }),
    /只能包含/
  );
  // 可约多项式
  assert.throws(
    () => analyzeFrame({ m: M, polyStr: '10101', t: T, blockCount: 2, frameStr: bits }),
    /可约/
  );
  // t 越界
  assert.throws(
    () => analyzeFrame({ m: M, polyStr: POLY, t: 8, blockCount: 2, frameStr: bits }),
    /参数组合非法/
  );
});

test('单块帧与单码字复核结果一致（模式切换不改变规则）', () => {
  const { field, gen } = setup(M, POLY, T);
  const c = systematicEncode(field, gen.g, gen.k, 0b1101001);
  const received = flip(c, [4]);
  const single = analyzeBch({ m: M, polyStr: POLY, t: T, rStr: received });
  const fr = analyzeFrame({ m: M, polyStr: POLY, t: T, blockCount: 1, frameStr: received });
  assert.equal(fr.adopted, true);
  assert.equal(fr.blocks[0].result.corrected, single.corrected);
  assert.deepEqual(
    fr.blocks[0].result.roots.map((x) => x.stringIndex0),
    single.roots.map((x) => x.stringIndex0)
  );
  assert.equal(fr.frameCorrected, single.corrected);
});

test('较大域 m=5 的连续帧同样闭合', () => {
  const m = 5;
  const poly = '100101';
  const t = 3;
  const { field, gen } = setup(m, poly, t);
  const n = field.n; // 31
  const clean = [
    systematicEncode(field, gen.g, gen.k, 0b1011010110),
    systematicEncode(field, gen.g, gen.k, 0b0100101101),
  ];
  const received = [flip(clean[0], [0, 30]), flip(clean[1], [5, 6, 7])];
  const fr = analyzeFrame({ m, polyStr: poly, t, blockCount: 2, frameStr: received.join('') });
  assert.equal(fr.adopted, true);
  assert.equal(fr.totalErrors, 5);
  assert.equal(fr.frameCorrected, clean.join(''));
  assert.deepEqual(
    fr.blocks[1].result.roots.map((x) => x.frameIndex1).sort((a, b) => a - b),
    [n + 6, n + 7, n + 8]
  );
});
