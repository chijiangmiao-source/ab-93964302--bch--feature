// test/frame.test.js — 连续帧批量复核（analyzeBchFrame）测试：
// 合法连续帧按块序给出逐块结论与拼接整帧；任一块失败时保留其余块并拒绝整帧；
// 块数 / 总长度 / 字符 / 参数非法时给出准确的中文原因。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeBch, analyzeBchFrame } from '../src/bch.js';
import { makeField, validatePrimitivePolynomial } from '../src/gf.js';
import { buildGenerator } from '../src/bch.js';

// BigInt GF(2)[x] 模（与系统编码一致的独立实现）
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

function systematicEncode(field, g, k, mBits) {
  const n = field.n;
  const mx = BigInt(mBits) << BigInt(n - k);
  const c = mx ^ bMod(mx, g);
  return c.toString(2).padStart(n, '0');
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

function setupCase() {
  const field = makeField(M, validatePrimitivePolynomial(M, POLY));
  const gen = buildGenerator(field, M, T);
  return { field, gen };
}

test('合法连续帧：按块序呈现可纠正结论、综合症摘要、串内错误位置、纠正码字与整帧拼接', () => {
  const { field, gen } = setupCase();
  // 三块，分别注入 1 / 0 / 2 个块内错误
  const c0 = systematicEncode(field, gen.g, gen.k, 0b1101001);
  const c1 = systematicEncode(field, gen.g, gen.k, 0b0001110);
  const c2 = systematicEncode(field, gen.g, gen.k, 0b1010101);
  const b0 = flip(c0, [2]);
  const b1 = c1;
  const b2 = flip(c2, [0, 13]);
  const frameStr = b0 + b1 + b2;

  const fr = analyzeBchFrame({ m: M, polyStr: POLY, t: T, blockCount: 3, frameStr });

  assert.equal(fr.mode, 'frame');
  assert.equal(fr.blockCount, 3);
  assert.equal(fr.n, N);
  assert.equal(fr.frame.length, 45);
  assert.equal(fr.allCorrectable, true);
  assert.equal(fr.blocks.length, 3);
  assert.equal(fr.correctedFrame, c0 + c1 + c2);

  // 块序与切分范围（1 基闭区间）
  assert.deepEqual(fr.blocks.map((b) => b.ordinal), [1, 2, 3]);
  assert.deepEqual(fr.blocks.map((b) => [b.range.start, b.range.end]), [[1, 15], [16, 30], [31, 45]]);
  for (const b of fr.blocks) {
    assert.equal(b.ok, true);
    assert.equal(b.result.received, frameStr.slice(b.index * N, (b.index + 1) * N));
    // 每块都完成既有复核流程：综合症条目数 = 2t
    assert.equal(b.result.syndromes.length, 2 * T);
    for (const s of b.result.syndromes) {
      assert.ok(['j', 'value', 'text'].every((k) => k in s));
      assert.match(s.text, /^0$|^α\^\d+$/);
    }
  }

  // 第 1 块：1 个错误
  assert.equal(fr.blocks[0].result.errorCount, 1);
  assert.equal(fr.blocks[0].result.corrected, c0);
  assert.match(fr.blocks[0].result.conclusion, /可纠正/);
  const root0 = fr.blocks[0].result.roots[0];
  assert.equal(root0.stringIndex0, 2); // 块内 0 基
  assert.equal(root0.stringIndex1, 3); // 块内 1 基

  // 第 2 块：零错误合法码字
  assert.equal(fr.blocks[1].result.errorCount, 0);
  assert.equal(fr.blocks[1].result.corrected, c1);
  assert.match(fr.blocks[1].result.conclusion, /综合症全部为零/);
  assert.deepEqual(fr.blocks[1].result.roots, []);

  // 第 3 块：2 个错误，串内位置
  assert.equal(fr.blocks[2].result.errorCount, 2);
  assert.equal(fr.blocks[2].result.corrected, c2);
  assert.deepEqual(fr.blocks[2].result.roots.map((x) => x.stringIndex0).sort(), [0, 13]);
});

test('逐块结果与单块入口 analyzeBch 完全一致（同一复核流程）', () => {
  const { field, gen } = setupCase();
  const c0 = systematicEncode(field, gen.g, gen.k, 0b1101001);
  const c1 = systematicEncode(field, gen.g, gen.k, 0b0110011);
  const b0 = flip(c0, [9]);
  const b1 = flip(c1, [1, 11]);
  const fr = analyzeBchFrame({ m: M, polyStr: POLY, t: T, blockCount: 2, frameStr: b0 + b1 });
  const single0 = analyzeBch({ m: M, polyStr: POLY, t: T, rStr: b0 });
  const single1 = analyzeBch({ m: M, polyStr: POLY, t: T, rStr: b1 });
  assert.deepEqual(JSON.parse(JSON.stringify(fr.blocks[0].result)), JSON.parse(JSON.stringify(single0)));
  assert.deepEqual(JSON.parse(JSON.stringify(fr.blocks[1].result)), JSON.parse(JSON.stringify(single1)));
});

test('某块超出纠错能力 / 定位证据不闭合：保留其余块结果，拒绝整帧采用且不给纠正整帧', () => {
  const { field, gen } = setupCase();
  const c0 = systematicEncode(field, gen.g, gen.k, 0b1101001);
  const c1 = systematicEncode(field, gen.g, gen.k, 0b1011001);
  const c2 = systematicEncode(field, gen.g, gen.k, 0b0101010);
  const b0 = flip(c0, [4]); // 可纠正
  const b1 = flip(c1, [1, 5, 11]); // t+1=3 错：该码此模式必须被拒绝
  const b2 = flip(c2, [7, 12]); // 可纠正
  const fr = analyzeBchFrame({ m: M, polyStr: POLY, t: T, blockCount: 3, frameStr: b0 + b1 + b2 });

  assert.equal(fr.allCorrectable, false);
  assert.equal('correctedFrame' in fr && fr.correctedFrame !== undefined, false);

  assert.equal(fr.blocks[0].ok, true);
  assert.equal(fr.blocks[0].result.corrected, c0);
  assert.equal(fr.blocks[2].ok, true);
  assert.equal(fr.blocks[2].result.corrected, c2);

  assert.equal(fr.blocks[1].ok, false);
  assert.equal(fr.blocks[1].result, undefined);
  assert.match(fr.blocks[1].reason, /超过纠错能力|无法闭合/);
  assert.equal(fr.blocks[1].ordinal, 2);
});

test('首块/末块失败时其余块同样保留，原始整帧始终回显', () => {
  const { field, gen } = setupCase();
  const c0 = systematicEncode(field, gen.g, gen.k, 0b1011001);
  const c1 = systematicEncode(field, gen.g, gen.k, 0b1101001);
  const b0 = flip(c0, [1, 5, 11]);
  const b1 = flip(c1, [3]);
  const frameStr = b0 + b1;
  const fr = analyzeBchFrame({ m: M, polyStr: POLY, t: T, blockCount: 2, frameStr });
  assert.equal(fr.frame, frameStr);
  assert.equal(fr.blocks[0].ok, false);
  assert.equal(fr.blocks[1].ok, true);
  assert.equal(fr.blocks[1].result.corrected, c1);
  assert.equal(fr.allCorrectable, false);
});

test('块数非法：0、负数、小数、空值均被拒绝', () => {
  const frame = '0'.repeat(2 * N);
  for (const bad of [0, -1, 1.5, NaN, '', null, undefined]) {
    assert.throws(
      () => analyzeBchFrame({ m: M, polyStr: POLY, t: T, blockCount: bad, frameStr: frame }),
      /块数非法/,
      `块数=${String(bad)} 应报块数非法`
    );
  }
  assert.throws(
    () => analyzeBchFrame({ m: M, polyStr: POLY, t: T, blockCount: 4097, frameStr: '0'.repeat(4097 * N) }),
    /块数非法/
  );
});

test('总长度不符：准确指出块数、每块码长、期望与实际长度', () => {
  assert.throws(
    () => analyzeBchFrame({ m: M, polyStr: POLY, t: T, blockCount: 3, frameStr: '0'.repeat(44) }),
    /3 块 × n=15.*应恰为 45 位，实际 44 位/
  );
  assert.throws(
    () => analyzeBchFrame({ m: M, polyStr: POLY, t: T, blockCount: 2, frameStr: '0'.repeat(31) }),
    /应恰为 30 位，实际 31 位/
  );
});

test('连续比特串为空或含非法字符：给出输入原因', () => {
  assert.throws(
    () => analyzeBchFrame({ m: M, polyStr: POLY, t: T, blockCount: 1, frameStr: '' }),
    /连续比特串为空/
  );
  assert.throws(
    () => analyzeBchFrame({ m: M, polyStr: POLY, t: T, blockCount: 2, frameStr: '0'.repeat(29) + 'x' }),
    /只能包含字符 0 和 1/
  );
  assert.throws(
    () => analyzeBchFrame({ m: M, polyStr: POLY, t: T, blockCount: 1, frameStr: '0'.repeat(14) + ' ' }),
    /只能包含字符 0 和 1/
  );
});

test('参数非法与单块同一中文原因：m、本原多项式、t', () => {
  const frame = '0'.repeat(N);
  assert.throws(
    () => analyzeBchFrame({ m: 4, polyStr: '10101', t: 1, blockCount: 1, frameStr: frame }),
    /可约/
  );
  assert.throws(
    () => analyzeBchFrame({ m: 21, polyStr: '1', t: 1, blockCount: 1, frameStr: '0' }),
    /域阶数 m 非法/
  );
  assert.throws(
    () => analyzeBchFrame({ m: M, polyStr: POLY, t: 8, blockCount: 1, frameStr: frame }),
    /参数组合非法/
  );
});

test('不同 m 下按当前码长切分仍闭合（m=3，n=7）', () => {
  const field = makeField(3, validatePrimitivePolynomial(3, '1011'));
  const gen = buildGenerator(field, 3, 1);
  const c0 = systematicEncode(field, gen.g, gen.k, 0b1010);
  const c1 = systematicEncode(field, gen.g, gen.k, 0b0110);
  const b0 = flip(c0, [6]);
  const b1 = flip(c1, [0]);
  const fr = analyzeBchFrame({ m: 3, polyStr: '1011', t: 1, blockCount: 2, frameStr: b0 + b1 });
  assert.equal(fr.n, 7);
  assert.equal(fr.frame.length, 14);
  assert.equal(fr.allCorrectable, true);
  assert.equal(fr.correctedFrame, c0 + c1);
  // 总长度不匹配时按 m=3 的码长报错
  assert.throws(
    () => analyzeBchFrame({ m: 3, polyStr: '1011', t: 1, blockCount: 2, frameStr: b0 + '0' }),
    /应恰为 14 位，实际 8 位/
  );
});
