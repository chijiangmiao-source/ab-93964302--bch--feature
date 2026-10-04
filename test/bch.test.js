// test/bch.test.js — BCH 构造与纠错规则测试（node --test）
// 采用与实现独立的交叉校验：g | x^n−1、g(α^j)=0、系统编码注入错误、
// 单错综合症 S_j=α^(ji)，以及超能力损坏必须被拒绝。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeBch, buildGenerator, computeSyndromes, berlekampMassey,
  chienSearch, cyclotomicCoset, formatBinaryPolynomial,
} from '../src/bch.js';
import { makeField, validatePrimitivePolynomial, binDeg } from '../src/gf.js';

// BigInt GF(2)[x] 模
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

test('循环陪集：n=15 时 C_1={1,2,4,8}, C_3={3,6,12,9}', () => {
  assert.deepEqual(cyclotomicCoset(1, 15), [1, 2, 4, 8]);
  assert.deepEqual(cyclotomicCoset(3, 15), [3, 6, 12, 9]);
});

test('生成多项式的标准值与次数', () => {
  // (15,11) Hamming: t=1, g=x4+x+1
  let { field, gen } = setup(4, '10011', 1);
  assert.equal(gen.degree, 4);
  assert.equal(gen.k, 11);
  assert.equal(gen.g.toString(2), '10011');

  // (15,7) BCH t=2: g=x8+x7+x6+x4+1
  ({ field, gen } = setup(4, '10011', 2));
  assert.equal(gen.degree, 8);
  assert.equal(gen.k, 7);
  assert.equal(gen.g.toString(2), '111010001');
  assert.equal(formatBinaryPolynomial(gen.g), 'x^8 + x^7 + x^6 + x^4 + 1');

  // (15,5) BCH t=3: 次数 10
  ({ field, gen } = setup(4, '10011', 3));
  assert.equal(gen.degree, 10);
  assert.equal(gen.k, 5);
  assert.equal(gen.g.toString(2), '10100110111');

  // (7,4) Hamming t=1
  ({ field, gen } = setup(3, '1011', 1));
  assert.equal(gen.degree, 3);
  assert.equal(gen.g.toString(2), '1011');
});

test('g 整除 x^n−1 且 g(α^j)=0，j=1..2t（独立交叉校验）', () => {
  for (const [m, bits, t] of [[4, '10011', 3], [3, '1011', 1], [5, '100101', 3], [6, '1000011', 3]]) {
    const { field, gen } = setup(m, bits, t);
    const n = field.n;
    // g | x^n + 1（GF(2) 下 x^n−1 = x^n+1）
    const xn = 1n << BigInt(n);
    assert.equal(bMod(xn ^ 1n, gen.g), 0n, `m=${m},t=${t}: g 不整除 x^n−1`);

    // 直接在域上求 g(α^j)
    for (let j = 1; j <= 2 * t; j++) {
      const root = field.exp[j % n];
      const bits2 = gen.g.toString(2);
      const deg = bits2.length - 1;
      let acc = 0;
      for (let p = 0; p < bits2.length; p++) {
        acc = field.mul(acc, root);
        if (bits2[p] === '1') acc ^= 1;
      }
      assert.equal(acc, 0, `m=${m},t=${t}: g(α^${j}) ≠ 0（串首位对应 x^${deg}）`);
    }
  }
});

/** 独立系统编码：c = m·x^(n−k) + (m·x^(n−k) mod g)，返回 n 位串（最左 x^(n−1)）。 */
function systematicEncode(field, g, k, mBits) {
  const n = field.n;
  const r = n - k;
  let mx = BigInt(mBits) << BigInt(r);
  const rem = bMod(mx, g);
  const c = mx ^ rem;
  return c.toString(2).padStart(n, '0');
}

function flip(str, positions) {
  const a = str.split('');
  for (const p of positions) a[p] = a[p] === '0' ? '1' : '0';
  return a.join('');
}

test('合法码字：综合症全零，零错误结论', () => {
  const res = analyzeBch({ m: 4, polyStr: '10011', t: 2, rStr: systematicEncode(makeField(4, 0b10011), setup(4, '10011', 2).gen.g, 7, 0b1011010) });
  assert.equal(res.errorCount, 0);
  assert.equal(res.corrected, res.received);
  assert.ok(res.syndromes.every((s) => s.value === 0));
});

test('单比特错误：S_j = α^(j·i)，位置正确且纠正后回原码字', () => {
  const { field, gen } = setup(4, '10011', 2);
  const c = systematicEncode(field, gen.g, gen.k, 0b1101001);
  const i = 9; // 码多项式幂次 x^9
  const received = flip(c, [field.n - 1 - i]);
  const syn = computeSyndromes(field, received, 4);
  for (let j = 1; j <= 4; j++) {
    assert.equal(syn[j - 1], field.exp[(j * i) % field.n], `S_${j}`);
  }
  const res = analyzeBch({ m: 4, polyStr: '10011', t: 2, rStr: received });
  assert.equal(res.errorCount, 1);
  assert.equal(res.roots[0].power, i);
  assert.equal(res.corrected, c);
});

test('随机注入不超过 t 个错误：全部正确纠正（多组参数）', () => {
  const cases = [
    [3, '1011', 1],
    [4, '10011', 1], [4, '10011', 2], [4, '10011', 3],
    [5, '100101', 2], [5, '100101', 3],
    [6, '1000011', 3], [7, '10000011', 2],
  ];
  // 可复现的伪随机
  let seed = 20261002;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

  for (const [m, bits, t] of cases) {
    const { field, gen } = setup(m, bits, t);
    for (let round = 0; round < 25; round++) {
      const msg = Math.floor(rand() * (1 << gen.k));
      const c = systematicEncode(field, gen.g, gen.k, msg);
      const errs = new Set();
      const eCount = 1 + Math.floor(rand() * t);
      while (errs.size < eCount) errs.add(Math.floor(rand() * field.n));
      const received = flip(c, [...errs]);
      const res = analyzeBch({ m, polyStr: bits, t, rStr: received });
      assert.equal(res.errorCount, eCount, `m=${m},t=${t},round=${round} 错误个数`);
      assert.equal(res.corrected, c, `m=${m},t=${t},round=${round} 纠正码字`);
      assert.equal(res.roots.length, res.locator.degree);
    }
  }
});

test('超过 t 个错误：要么明确拒绝，要么纠成另一个合法码字（绝不伪装成原数据）', () => {
  const { field, gen } = setup(4, '10011', 2);
  const c = systematicEncode(field, gen.g, gen.k, 0b1011001);
  // 恰好 3 = t+1 个错误
  const received = flip(c, [1, 5, 11]);
  let rejected = false;
  let res = null;
  try {
    res = analyzeBch({ m: 4, polyStr: '10011', t: 2, rStr: received });
  } catch (e) {
    rejected = true;
  }
  if (!rejected) {
    // 即便 BM 闭合，结果必须是与发送码字不同的另一个合法码字
    assert.notEqual(res.corrected, c);
    assert.ok(res.syndromes && res.roots.length === res.locator.degree);
  }
});

test('三错超出 t=2：Chien 根数与定位多项式次数不符时明确拒绝', () => {
  // 非完美 (15,7,2) 码：某些三错模式 BM 给出 deg 2 但 Chien 找不到 2 个根，
  // 此时必须拒绝，而不是把损坏伪装成正常数据。
  const { field, gen } = setup(4, '10011', 2);
  const c = systematicEncode(field, gen.g, gen.k, 0b1011001);
  const received = flip(c, [1, 5, 11]);
  assert.throws(
    () => analyzeBch({ m: 4, polyStr: '10011', t: 2, rStr: received }),
    /超过纠错能力|无法闭合/
  );
});

test('非本原/可约多项式在构造任何编码证据前就被拒绝', () => {
  assert.throws(() => analyzeBch({ m: 4, polyStr: '10101', t: 1, rStr: '0'.repeat(15) }), /可约/);
  assert.throws(() => analyzeBch({ m: 6, polyStr: '1001001', t: 1, rStr: '0'.repeat(63) }), /不是本原/);
});

test('非法输入组合：码长不符、字符非法、t 越界', () => {
  assert.throws(() => analyzeBch({ m: 4, polyStr: '10011', t: 1, rStr: '0'.repeat(14) }), /长度非法/);
  assert.throws(() => analyzeBch({ m: 4, polyStr: '10011', t: 1, rStr: '0'.repeat(16) }), /长度非法/);
  assert.throws(() => analyzeBch({ m: 4, polyStr: '10011', t: 1, rStr: '0'.repeat(14) + 'x' }), /长度非法|只能包含/);
  assert.throws(() => analyzeBch({ m: 4, polyStr: '10011', t: 0, rStr: '0'.repeat(15) }), /纠错能力/);
  assert.throws(() => analyzeBch({ m: 4, polyStr: '10011', t: 8, rStr: '0'.repeat(15) }), /参数组合非法/);
});

test('BM 与 Chien 结构：无错时 Λ=1、deg 0、无根', () => {
  const { field } = setup(4, '10011', 2);
  const syn = [0, 0, 0, 0];
  const { lambda, L } = berlekampMassey(field, syn);
  assert.equal(L, 0);
  assert.deepEqual(lambda, [1]);
  assert.deepEqual(chienSearch(field, lambda, L), []);
});

test('m=8 较大参数下生成多项式与 t 个错误纠正仍闭合', () => {
  const { field, gen } = setup(8, '100011101', 2);
  assert.equal(field.n, 255);
  assert.equal(gen.degree, 16); // BCH(255,239,t=2)：|C1|=8, |C3|=8
  let seed = 77;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const msg = Math.floor(rand() * 2 ** gen.k);
  const c = systematicEncode(field, gen.g, gen.k, msg);
  const positions = new Set();
  while (positions.size < 2) positions.add(Math.floor(rand() * 255));
  const received = flip(c, [...positions]);
  const res = analyzeBch({ m: 8, polyStr: '100011101', t: 2, rStr: received });
  assert.equal(res.errorCount, 2);
  assert.equal(res.corrected, c);
});
