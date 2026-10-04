// gf.js
// 有限域 GF(2) 与 GF(2^m) 的零依赖实现，浏览器 Worker 与 Node 测试共用。
//
// 约定（全项目统一）：
//   - GF(2) 上的多项式用“二进制整数”表示：整数的第 i 位即 x^i 的系数。
//     例如 f = x^4 + x + 1 写作整数 0b10011。
//   - GF(2^m) 中的域元素同样用整数位向量表示（第 i 位是 α 基下 x^i 的系数），
//     α = x 在模本原多项式 f 下的陪元。
//   - 码多项式 r(x) 为 GF(2) 上次数 < n 的多项式；接收串第 0 个字符（最左）
//     对应 x^(n-1) 系数，最右字符对应 x^0 系数。综合症、BM、Chien 全程使用
//     这一位序，不再重新排列。

/** 二进制多项式次数；零多项式返回 -1。 */
export function binDeg(p) {
  if (p === 0) return -1;
  return 31 - Math.clz32(p);
}

/** GF(2)[x] 乘法（移位异或）。 */
export function binMul(a, b) {
  let r = 0;
  while (b) {
    if (b & 1) r ^= a;
    a <<= 1;
    b >>= 1;
  }
  return r;
}

/** GF(2)[x] 取模（长除法），返回余式。 */
export function binMod(a, m) {
  const dm = binDeg(m);
  let r = a;
  let dr = binDeg(r);
  while (dr >= dm) {
    r ^= m << (dr - dm);
    dr = binDeg(r);
  }
  return r;
}

/** GF(2)[x] 幂模。 */
export function binPowMod(base, exp, m) {
  let r = 1;
  let b = base;
  while (exp > 0) {
    if (exp & 1) r = binMod(binMul(r, b), m);
    b = binMod(binMul(b, b), m);
    exp >>= 1;
  }
  return r;
}

/** GF(2)[x] 最大公因式。 */
export function binGcd(a, b) {
  while (b) {
    [a, b] = [b, binMod(a, b)];
  }
  return a;
}

/** 返回整数 n 的全部互异素因子（试除，n 对本项目规模足够小）。 */
export function distinctPrimeFactors(n) {
  const factors = [];
  let v = n;
  for (let p = 2; p * p <= v; p++) {
    if (v % p === 0) {
      factors.push(p);
      while (v % p === 0) v = Math.floor(v / p);
    }
  }
  if (v > 1) factors.push(v);
  return factors;
}

/**
 * 判定 f（二进制整数，次数恰为 m）是否在 GF(2) 上不可约。
 * Rabini 判据：
 *   f | x^(2^m) - x，且对 m 的每个素因子 q，gcd(f, x^(2^(m/q)) - x) = 1。
 * 特征 2 下减法即加法（按位异或）。
 */
export function isIrreducible(f, m) {
  if (m <= 0 || binDeg(f) !== m) return false;
  // x^(2^r) mod f，利用 Frobenius 自同构反复平方。
  const xPow2r = (r) => {
    let v = 0b10; // x
    for (let i = 0; i < r; i++) v = binMod(binMul(v, v), f);
    return v;
  };
  if (xPow2r(m) !== 0b10) return false; // x^(2^m) ≡ x (mod f)
  for (const q of distinctPrimeFactors(m)) {
    const v = xPow2r(Math.floor(m / q));
    if (binGcd(f, v ^ 0b10) !== 1) return false; // x^(2^(m/q)) - x
  }
  return true;
}

/**
 * 判定不可约多项式 f 是否为本原多项式：x（陪元 α）的乘法阶恰为 2^m-1。
 * 不可约时阶整除 n，只需验证对 n 的每个素因子 p，α^(n/p) ≠ 1。
 */
export function isPrimitiveRootOrder(f, m) {
  const n = (1 << m) - 1;
  for (const p of distinctPrimeFactors(n)) {
    if (binPowMod(0b10, Math.floor(n / p), f) === 1) return false;
  }
  return true;
}

/**
 * 校验用户输入的本原多项式比特串。
 * 要求：仅含 0/1；长度恰为 m+1；首位置 1（x^m 系数）；末位置 1（常数项）；
 * 在 GF(2) 上不可约；且 x 的阶为 2^m-1。
 * 任何不满足都抛出带中文原因的 Error。
 */
export function validatePrimitivePolynomial(m, polyStr) {
  if (!Number.isInteger(m) || m < 2 || m > 20) {
    throw new Error('域阶数 m 非法：需为 2 ≤ m ≤ 20 的整数（码长 2^m−1）。');
  }
  if (typeof polyStr !== 'string' || !/^[01]+$/.test(polyStr)) {
    throw new Error('本原多项式比特串非法：只能包含字符 0 和 1。');
  }
  if (polyStr.length !== m + 1) {
    throw new Error(
      `本原多项式比特串长度非法：m 次多项式应为 ${m + 1} 位（含 x^m 与常数项），实际 ${polyStr.length} 位。`
    );
  }
  if (polyStr[0] !== '1') {
    throw new Error('本原多项式次数不足 m：首位（x^m 系数）必须为 1。');
  }
  if (polyStr[polyStr.length - 1] !== '1') {
    throw new Error('本原多项式非法：常数项（末位）必须为 1，否则多项式可约。');
  }
  const f = parseInt(polyStr, 2);
  if (!isIrreducible(f, m)) {
    throw new Error(`多项式 ${polyStr} 在 GF(2) 上可约，不是 ${m} 次不可约多项式，更非本原多项式。`);
  }
  if (!isPrimitiveRootOrder(f, m)) {
    throw new Error(
      `多项式 ${polyStr} 虽不可约，但 x 的乘法阶不等于 2^${m}−1，不是本原多项式。`
    );
  }
  return f;
}

/**
 * 构造 GF(2^m)：以 α = x 为生成元，建立指数表/对数表。
 * 返回 { m, f, n, exp, log, mul, div, add }。
 */
export function makeField(m, f) {
  const n = (1 << m) - 1;
  const top = 1 << m;
  const exp = new Int32Array(n + 1); // exp[n] = exp[0] = 1
  const log = new Int32Array(top).fill(-1);

  let v = 1;
  for (let i = 0; i < n; i++) {
    exp[i] = v;
    log[v] = i;
    v <<= 1; // α^(i+1) = α^i · α = α^i · x
    if (v & top) v ^= f;
  }
  exp[n] = 1;

  return {
    m,
    f,
    n,
    exp,
    log,
    add: (a, b) => a ^ b,
    mul(a, b) {
      if (a === 0 || b === 0) return 0;
      return exp[(log[a] + log[b]) % n];
    },
    div(a, b) {
      if (b === 0) throw new Error('域运算错误：除数为零。');
      if (a === 0) return 0;
      return exp[(log[a] - log[b] + n) % n];
    },
    isElement: (a) => Number.isInteger(a) && a >= 0 && a <= n,
  };
}

/** 域元素格式化为 α 幂记号：0 记为 0，1 记为 α^0。 */
export function formatElement(field, a) {
  if (a === 0) return '0';
  const i = field.log[a];
  return i === 0 ? '1' : `α^${i}`;
}
