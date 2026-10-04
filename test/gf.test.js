// test/gf.test.js — 有限域与本原多项式判据测试（node --test）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  binDeg, binMul, binMod, binPowMod, binGcd,
  isIrreducible, isPrimitiveRootOrder, validatePrimitivePolynomial,
  makeField, distinctPrimeFactors,
} from '../src/gf.js';

test('GF(2)[x] 基本运算与次数', () => {
  assert.equal(binDeg(0), -1);
  assert.equal(binDeg(1), 0);
  assert.equal(binDeg(0b10011), 4);
  assert.equal(binMul(0b1011, 0b11), 0b11101); // (x3+x+1)(x+1) = x4+x3+x2+1
  assert.equal(binMul(0b1011, 0b11).toString(2), '11101');
  assert.equal(binMod(binMul(0b1011, 0b11), 0b10011).toString(2), '1110');
  assert.equal(binGcd(0b1101, 0b1011), 0b1); // 两式互素
});

test('x^(2^m) ≡ x (mod f) 对不可约多项式成立', () => {
  // m=4, f=x4+x+1
  assert.ok(isIrreducible(0b10011, 4));
  assert.ok(isPrimitiveRootOrder(0b10011, 4));
  // 可约：x4+x2+1 = (x2+x+1)^2
  assert.equal(isIrreducible(0b10101, 4), false);
});

test('不可约但非本原：m=6, x6+x3+1 (01001001 => 1001001) 不可约但阶为 9', () => {
  const f = 0b1001001; // x6+x3+1
  assert.ok(isIrreducible(f, 6));
  assert.equal(isPrimitiveRootOrder(f, 6), false);
  assert.throws(() => validatePrimitivePolynomial(6, '1001001'), /不是本原多项式/);
});

test('常见本原多项式表抽样', () => {
  const primitives = {
    2: '111',          // x2+x+1
    3: '1011',         // x3+x+1
    4: '10011',        // x4+x+1
    5: '100101',       // x5+x2+1
    7: '10000011',     // x7+x+1
    8: '100011101',    // x8+x4+x3+x2+1
  };
  for (const [m, bits] of Object.entries(primitives)) {
    const f = validatePrimitivePolynomial(Number(m), bits);
    assert.equal(binDeg(f), Number(m));
  }
});

test('validatePrimitivePolynomial 的各类非法输入给出中文原因', () => {
  assert.throws(() => validatePrimitivePolynomial(4, '1001'), /长度非法/);
  assert.throws(() => validatePrimitivePolynomial(4, '00011'), /次数不足/);
  assert.throws(() => validatePrimitivePolynomial(4, '10010'), /常数项/);
  assert.throws(() => validatePrimitivePolynomial(4, '10a11'), /只能包含/);
  assert.throws(() => validatePrimitivePolynomial(1, '11'), /域阶数/);
});

test('GF(2^m) 指数/对数表：α^n=1，遍历全部非零元素且两两不同', () => {
  const field = makeField(4, 0b10011);
  assert.equal(field.n, 15);
  assert.equal(field.exp[15], 1);
  const seen = new Set();
  for (let i = 0; i < 15; i++) seen.add(field.exp[i]);
  assert.equal(seen.size, 15);
  // α^4 = α+1，α^5 = α²+α，对 f=x4+x+1
  assert.equal(field.exp[4], 0b11);
  assert.equal(field.exp[5], 0b110);
  assert.equal(field.mul(field.exp[7], field.exp[8]), 1);
  assert.equal(field.div(field.exp[10], field.exp[3]), field.exp[7]);
});

test('素因子分解', () => {
  assert.deepEqual(distinctPrimeFactors(15), [3, 5]);
  assert.deepEqual(distinctPrimeFactors(31), [31]);
  assert.deepEqual(distinctPrimeFactors(63), [3, 7]);
});

test('binPowMod 与域幂一致', () => {
  const f = 0b10011;
  assert.equal(binPowMod(2, 15, f), 1);
  assert.equal(binPowMod(2, 5, f), 0b110);
});
