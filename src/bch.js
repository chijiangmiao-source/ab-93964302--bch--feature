// bch.js
// 窄义二进制本原 BCH 码（narrow-sense primitive binary BCH）离线复核。
//
// 码长 n = 2^m − 1，生成多项式 g(x) 以连续根 α, α², …, α^(2t) 构造：
//   g(x) = lcm(M_1, M_2, …, M_{2t})，M_j 为 α^j 在 GF(2) 上的最小多项式。
// 位序约定见 gf.js：接收串最左字符对应 x^(n−1)，综合症/BM/Chien 全程一致。

import {
  binDeg,
  binMul,
  binMod,
  binPowMod,
  makeField,
  validatePrimitivePolynomial,
} from './gf.js';

/** BigInt 版 GF(2)[x] 乘法（移位异或），用于可能很长的生成多项式。 */
function bMul(a, b) {
  let r = 0n;
  while (b) {
    if (b & 1n) r ^= a;
    a <<= 1n;
    b >>= 1n;
  }
  return r;
}

/** BigInt 版 GF(2)[x] 取模。 */
function bMod(a, m) {
  const dm = m.toString(2).length - 1;
  let r = a;
  let dr = r.toString(2).length - 1;
  if (r === 0n) return 0n;
  while (dr >= dm) {
    r ^= m << BigInt(dr - dm);
    dr = r === 0n ? -1 : r.toString(2).length - 1;
  }
  return r;
}

function bPowMod(base, exp, m) {
  let r = 1n;
  let b = base;
  while (exp > 0n) {
    if (exp & 1n) r = bMod(bMul(r, b), m);
    b = bMod(bMul(b, b), m);
    exp >>= 1n;
  }
  return r;
}

/** 把 GF(2) 多项式（BigInt 位向量）格式化为 x 的多项式文本。 */
export function formatBinaryPolynomial(big) {
  if (big === 0n) return '0';
  const deg = big.toString(2).length - 1;
  const terms = [];
  for (let i = deg; i >= 0; i--) {
    if ((big >> BigInt(i)) & 1n) {
      if (i === 0) terms.push('1');
      else if (i === 1) terms.push('x');
      else terms.push(`x^${i}`);
    }
  }
  return terms.join(' + ');
}

/** α 的模 n 二倍循环陪集 C_s = {s, 2s, 4s, …} (mod n)。 */
export function cyclotomicCoset(s, n) {
  const members = [];
  let v = s;
  do {
    members.push(v);
    v = (v * 2) % n;
  } while (v !== s);
  return members;
}

/**
 * 最小多项式 M_s(x) = ∏_{j∈C_s} (x − α^j)，系数必落在 GF(2)。
 * 在域上逐次乘一次因子，最后校验系数确为 0/1 并以 BigInt 返回。
 */
function minimalPolynomial(field, members) {
  let coeff = [1]; // 多项式 1，coeff[i] 为 x^i 系数（域元素）
  for (const e of members) {
    const root = field.exp[e];
    const next = new Array(coeff.length + 1).fill(0);
    for (let i = 0; i < coeff.length; i++) {
      next[i + 1] ^= coeff[i]; // x 项
      next[i] ^= field.mul(root, coeff[i]); // 常数根项
    }
    coeff = next;
  }
  let bits = 0n;
  coeff.forEach((c, i) => {
    if (c !== 0 && c !== 1) {
      throw new Error('内部错误：最小多项式系数未落在 GF(2)，陪集构造有误。');
    }
    if (c === 1) bits |= 1n << BigInt(i);
  });
  return bits;
}

/**
 * 构造窄义 BCH 生成多项式。
 * 返回 { g(bigint), degree, k, cosets:[{rep,members,minPoly}], n }。
 */
export function buildGenerator(field, m, t) {
  const n = field.n;
  if (!Number.isInteger(t) || t < 1) {
    throw new Error('纠错能力 t 非法：需为不小于 1 的整数。');
  }
  if (2 * t > n - 1) {
    throw new Error(
      `参数组合非法：设计距离 2t+1=${2 * t + 1} 超过码长 n=${n}，要求 1 ≤ t ≤ 2^${m}−2 的一半（t ≤ ${(n - 1) >> 1}）。`
    );
  }

  const byRep = new Map();
  for (let s = 1; s <= 2 * t; s++) {
    const members = cyclotomicCoset(s, n);
    const rep = Math.min(...members);
    if (!byRep.has(rep)) {
      byRep.set(rep, members);
    }
  }

  let g = 1n;
  const cosets = [];
  let totalDegree = 0;
  for (const [rep, members] of [...byRep.entries()].sort((a, b) => a[0] - b[0])) {
    const mp = minimalPolynomial(field, members);
    const deg = mp.toString(2).length - 1;
    totalDegree += deg;
    g = bMul(g, mp);
    cosets.push({
      rep,
      members: members.slice().sort((a, b) => a - b),
      minPolyBits: mp.toString(2),
      minPolyText: formatBinaryPolynomial(mp),
      degree: deg,
    });
  }

  const degree = g.toString(2).length - 1;
  if (degree !== totalDegree) {
    throw new Error('内部错误：生成多项式次数与最小多项式次数之和不一致（因子不互素）。');
  }
  if (degree > m * t) {
    throw new Error(`内部错误：生成多项式次数 ${degree} 超过 BCH 界 mt=${m * t}。`);
  }
  const k = n - degree;
  if (degree < 1 || k < 1) {
    throw new Error(
      `生成多项式次数 ${degree} 不满足有效码长：要求 1 ≤ deg(g) ≤ n−1=${n - 1}（信息位 k=n−deg(g) 必须为正）。`
    );
  }

  return { g, degree, k, cosets, n };
}

/**
 * 综合症 S_j = r(α^j)，j = 1..2t，Horner 求值。
 * 接收串最左为 x^(n−1) 系数，逐字符：acc ← acc·α^j + c_i。
 */
export function computeSyndromes(field, rStr, twoT) {
  const n = field.n;
  if (rStr.length !== n) {
    throw new Error(`接收码字长度非法：应为 n=2^m−1=${n} 位，实际 ${rStr.length} 位。`);
  }
  if (!/^[01]+$/.test(rStr)) {
    throw new Error('接收码字非法：只能包含字符 0 和 1。');
  }
  const syndromes = [];
  for (let j = 1; j <= twoT; j++) {
    const beta = field.exp[j % n]; // α^j
    let acc = 0;
    for (let p = 0; p < rStr.length; p++) {
      acc = field.mul(acc, beta);
      if (rStr[p] === '1') acc ^= 1;
    }
    syndromes.push(acc);
  }
  return syndromes;
}

/**
 * Berlekamp–Massey，输入 S_1..S_{2t}（数组下标 0 对应 S_1）。
 * 返回定位多项式系数数组 Λ[0..L]，Λ(x)=Σ Λ_i x^i，GF(2) 上减法即异或。
 */
export function berlekampMassey(field, syndromes) {
  const N = syndromes.length;
  const S = (i) => syndromes[i - 1]; // i 为 1 基
  let C = [1];
  let B = [1];
  let L = 0;
  let shift = 1;
  let b = 1;

  for (let n = 1; n <= N; n++) {
    let d = S(n);
    for (let i = 1; i <= L; i++) {
      if (C[i] !== 0 && S(n - i) !== 0) d ^= field.mul(C[i], S(n - i));
    }
    if (d === 0) {
      shift++;
      continue;
    }
    const T = C.slice();
    const coef = field.div(d, b);
    const grown = new Array(Math.max(C.length, B.length + shift)).fill(0);
    C.forEach((v, i) => { grown[i] = v; });
    B.forEach((v, i) => {
      if (v !== 0) grown[i + shift] ^= field.mul(coef, v);
    });
    C = grown;
    if (2 * L <= n - 1) {
      L = n - L;
      B = T;
      b = d;
      shift = 1;
    } else {
      shift++;
    }
  }

  C.length = L + 1;
  return { lambda: C, L };
}

/** 定位多项式文本：Λ(x) = 1 + α^u x + …。 */
export function formatLocator(field, lambda) {
  const terms = [];
  lambda.forEach((c, i) => {
    if (c === 0) return;
    if (i === 0) terms.push('1');
    else if (i === 1) terms.push(c === 1 ? 'x' : `α^${field.log[c]} x`);
    else terms.push(c === 1 ? `x^${i}` : `α^${field.log[c]} x^${i}`);
  });
  return terms.length ? terms.join(' + ') : '0';
}

/**
 * Chien 搜索：错误出现在 x^i 位当且仅当 Λ(α^(−i)) = 0，i = 0..n−1。
 * 返回命中幂次列表（幂次 = 码多项式位指数）。
 */
export function chienSearch(field, lambda, L) {
  const n = field.n;
  const hits = [];
  for (let i = 0; i < n; i++) {
    const z = field.exp[(n - i) % n]; // α^(−i)
    let acc = 0;
    for (let p = L; p >= 0; p--) {
      acc = field.mul(acc, z);
      if (lambda[p]) acc ^= lambda[p];
    }
    if (acc === 0) hits.push(i);
  }
  return hits;
}

/**
 * 单块复核的内部管线：本原多项式与生成多项式已在外部验证/构造完毕，
 * 此处只跑接收串校验 → 综合症 → BM → Chien → 翻转后综合症归零裁决。
 * 单块入口 analyzeBch 与连续帧入口 analyzeBchFrame 共用本函数，
 * 以保证“每个块接受既有复核流程”。
 */
function analyzeBlock(field, { m, polyStr, t, generator, rStr }) {
  const n = field.n;
  // 3) 接收串合法性。
  if (typeof rStr !== 'string' || rStr.length !== n || !/^[01]+$/.test(rStr)) {
    if (typeof rStr !== 'string' || !/^[01]+$/.test(rStr)) {
      throw new Error('接收码字非法：只能包含字符 0 和 1。');
    }
    throw new Error(`接收码字长度非法：应为 n=2^m−1=${n} 位，实际 ${rStr.length} 位。`);
  }

  // 4) 综合症。
  const twoT = 2 * t;
  const syndromes = computeSyndromes(field, rStr, twoT);
  const syndromeView = syndromes.map((v, idx) => ({
    j: idx + 1,
    value: v,
    text: v === 0 ? '0' : `α^${field.log[v]}`,
  }));

  const allZero = syndromes.every((v) => v === 0);

  // 5) Berlekamp–Massey。
  const { lambda, L } = berlekampMassey(field, syndromes);
  if (L > t) {
    throw new Error(
      `不可纠正：BM 定位多项式次数 L=${L} 超过纠错能力 t=${t}，损坏超出该码设计能力。`
    );
  }

  // 6) Chien 搜索。
  const roots = chienSearch(field, lambda, L);
  if (roots.length !== L) {
    throw new Error(
      `定位证据无法闭合：定位多项式次数为 ${L}，但 Chien 搜索在 ${n} 个比特位置中只找到 ${roots.length} 个根，不可伪装为正常数据。`
    );
  }

  // 7) 翻转命中位，重新计算全部综合症，必须全部归零。
  const corrected = rStr.split('');
  for (const i of roots) {
    const idx = n - 1 - i; // 串下标（最左为 0，对应 x^(n−1)）
    corrected[idx] = corrected[idx] === '1' ? '0' : '1';
  }
  const cStr = corrected.join('');
  const postSyndromes = computeSyndromes(field, cStr, twoT);
  if (!postSyndromes.every((v) => v === 0)) {
    const nonzero = postSyndromes
      .map((v, idx) => (v === 0 ? null : `S_${idx + 1}=α^${field.log[v]}`))
      .filter(Boolean)
      .join(', ');
    throw new Error(
      `定位证据无法闭合：按定位结果纠正后综合症仍非零（${nonzero}），拒绝给出可纠正结论。`
    );
  }

  return {
    params: { m, n, t, primitiveBits: polyStr, k: generator.k },
    field: { order: n, generatorPolynomialBits: polyStr },
    generator: {
      bits: generator.g.toString(2),
      text: formatBinaryPolynomial(generator.g),
      degree: generator.degree,
      k: generator.k,
      cosets: generator.cosets,
    },
    syndromes: syndromeView,
    locator: {
      degree: L,
      text: formatLocator(field, lambda),
      coefficients: lambda.map((v, i) => ({
        i,
        value: v,
        text: v === 0 ? '0' : v === 1 ? '1' : `α^${field.log[v]}`,
      })),
    },
    roots: roots.map((i) => ({
      power: i, // x^i
      rootText: `α^${(n - i) % n}`, // Λ 的根 α^(−i)
      stringIndex0: n - 1 - i, // 串内 0 基下标（自左向右）
      stringIndex1: n - i, // 串内 1 基位置（自左向右）
    })),
    errorCount: L,
    received: rStr,
    corrected: cStr,
    changed: allZero && L === 0,
    conclusion:
      L === 0
        ? '综合症全部为零：接收码字本身就是合法码字，无需纠正。'
        : `可纠正：定位到 ${L} 个错误比特，纠正后全部 ${twoT} 个综合症归零。`,
  };
}

/**
 * 完整单块复核入口（保留原有行为）。成功返回结构化证据；
 * 本原多项式、参数组合、接收串或定位证据任一环无法闭合时抛出中文 Error。
 *
 * 输入：
 *   m        域阶数（2..20）
 *   polyStr  m 次本原多项式比特串（首位 x^m，末位常数项）
 *   t        纠错能力
 *   rStr     长度恰为 2^m−1 的接收码字（最左为 x^(n−1)）
 */
export function analyzeBch({ m, polyStr, t, rStr }) {
  // 1) 先验证多项式确为 m 次本原多项式。
  const f = validatePrimitivePolynomial(m, polyStr);
  const field = makeField(m, f);

  // 2) 由连续根 α..α^(2t) 的循环陪集构造二进制生成多项式。
  const generator = buildGenerator(field, m, t);

  // 3..7) 与连续帧共用同一条逐块复核管线。
  return analyzeBlock(field, { m, polyStr, t, generator, rStr });
}

/**
 * 连续帧批量复核入口。地面工程师一次下传得到 blockCount 个使用同一组
 * BCH 参数（m / 本原多项式 / t）的等长码字，拼接为一段连续比特串。
 *
 * 本函数按当前 m 推导出的码长 n = 2^m−1 切分：第 b 块为 frame[b·n … (b+1)n)，
 * 每个块都走与 analyzeBch 完全相同的复核流程（analyzeBlock）。
 *
 * 与单块不同的整体级输入错误（块数非法、总长度不等于 blockCount·n、
 * 比特串含非 0/1 字符）直接抛出中文 Error，不产生任何块结论。
 * 参数级错误（m / 多项式 / t 非法）同样直接抛出，错误信息与单块一致。
 *
 * 块级失败（超出纠错能力、定位证据不闭合等）不会中断其余块：
 * 返回 { mode:'frame', params, generator, blockCount, n, frame, correctedFrame,
 *         allCorrectable, blocks:[{index, range, ok, result? , reason?}] }，
 * 仅当所有块 ok 时 allCorrectable 才为真，correctedFrame 也只在此时给出。
 */
export function analyzeBchFrame({ m, polyStr, t, blockCount, frameStr }) {
  // 1) 块数合法性：正整数；同时给出上限，避免异常输入导致病态切分。
  const count = Number(blockCount);
  if (!Number.isInteger(count) || count < 1) {
    throw new Error('块数非法：需为不小于 1 的整数。');
  }
  if (count > 4096) {
    throw new Error(`块数非法：单次批量复核最多 4096 块，实际 ${count} 块。`);
  }

  // 2) 连续比特串字符合法性（与长度无关，先于参数检查给出准确原因）。
  if (typeof frameStr !== 'string' || frameStr.length === 0) {
    throw new Error('连续比特串为空：请粘贴整帧连续比特（仅含 0/1，块间不要插入分隔符或空白）。');
  }
  if (!/^[01]+$/.test(frameStr)) {
    throw new Error('连续比特串非法：只能包含字符 0 和 1（块间不要插入分隔符或空白）。');
  }

  // 3) 验证多项式确为 m 次本原多项式（与单块同一入口、同一中文错误），推导码长 n。
  const f = validatePrimitivePolynomial(m, polyStr);
  const field = makeField(m, f);
  const n = field.n;

  // 4) 总长度必须恰为 blockCount·n。
  const expectedLen = count * n;
  if (frameStr.length !== expectedLen) {
    throw new Error(
      `连续比特串总长度非法：${count} 块 × n=${n}（2^${m}−1）应恰为 ${expectedLen} 位，实际 ${frameStr.length} 位（相差 ${Math.abs(frameStr.length - expectedLen)} 位）。`
    );
  }

  // 5) 生成多项式只构造一次；参数非法时（如 t 越界）在逐块复核前直接失败。
  const generator = buildGenerator(field, m, t);

  // 5) 逐块切分并走既有复核流程；任一块失败都保留其余块结果。
  const blocks = [];
  let allCorrectable = true;
  for (let b = 0; b < count; b++) {
    const start = b * n;
    const rStr = frameStr.slice(start, start + n);
    const block = {
      index: b,
      ordinal: b + 1,
      range: { start: start + 1, end: start + n }, // 串内 1 基闭区间
      ok: false,
    };
    try {
      block.result = analyzeBlock(field, { m, polyStr, t, generator, rStr });
      block.ok = true;
    } catch (err) {
      block.ok = false;
      block.reason = err && err.message ? err.message : String(err);
      allCorrectable = false;
    }
    blocks.push(block);
  }

  const response = {
    mode: 'frame',
    params: { m, n, t, blockCount: count, primitiveBits: polyStr, k: generator.k },
    generator: {
      bits: generator.g.toString(2),
      text: formatBinaryPolynomial(generator.g),
      degree: generator.degree,
      k: generator.k,
      cosets: generator.cosets,
    },
    blockCount: count,
    n,
    frame: frameStr,
    blocks,
    allCorrectable,
  };
  if (allCorrectable) {
    response.correctedFrame = blocks.map((b) => b.result.corrected).join('');
  }
  return response;
}

// 小参数场景的整数版工具，供测试直接复核整除性（公共 API）。
export const smallIntHelpers = { binDeg, binMul, binMod, binPowMod };
