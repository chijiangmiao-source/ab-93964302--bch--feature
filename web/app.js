// app.js — 页面交互：把输入交给 Worker，渲染证据；失败时稳定清除旧成功证据。
// 两种模式共用 m / 本原多项式 / t：
//   single 单码字复核：行为与历史完全一致；
//   frame  连续帧批量复核：按 n=2^m−1 切分，逐块走同一复核流程，
//          任一块失败仍保留其余块结果，但拒绝整帧采用。

const $ = (id) => document.getElementById(id);
const inputs = ['m', 'poly', 't', 'r'];
const frameInputs = ['block-count', 'frame'];

let worker = null;
let busy = false;
let mode = 'single';

const SINGLE_SECTIONS = ['result', 'result2', 'result3', 'result4', 'result5'];
const FRAME_SECTIONS = ['frame-result'];
const ALL_SECTIONS = [...SINGLE_SECTIONS, ...FRAME_SECTIONS];

function currentMode() {
  return document.querySelector('input[name="mode"]:checked')?.value || 'single';
}

function createWorker() {
  if (worker) worker.terminate();
  worker = new Worker('./worker.js', { type: 'module' });
  worker.onmessage = (e) => {
    busy = false;
    setButtons();
    const msg = e.data || {};
    if (msg.type === 'result') renderSingleSuccess(msg.result);
    else if (msg.type === 'frameResult') renderFrameSuccess(msg.result);
    else renderFailure(msg.message || '未知错误。');
  };
  worker.onerror = (e) => {
    busy = false;
    setButtons();
    renderFailure(`Worker 执行异常：${e.message || '未知错误'}`);
  };
}

function setButtons() {
  $('btn-run').disabled = busy;
  $('btn-run').textContent = busy ? (mode === 'frame' ? '批量复核中…' : '复核中…') : '复核';
}

function setStatus(text, cls) {
  const el = $('status');
  el.textContent = text;
  el.className = cls || '';
}

/** 清除一切旧结论（成功证据与失败提示同时清空）。 */
function clearConclusions() {
  for (const id of ALL_SECTIONS) {
    $(id).classList.remove('show');
  }
  $('fail').classList.remove('show');
  setStatus('', '');
}

function renderFailure(reason) {
  clearConclusions();
  $('fail-reason').textContent = reason;
  $('fail').classList.add('show');
  setStatus('复核失败：' + reason, 'err');
}

function el(tag, text) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  return e;
}

/* ---------------------------------------------------------------------------
 * 单码字复核（既有渲染逻辑，未改变行为）
 * ------------------------------------------------------------------------- */

function renderSingleSuccess(r) {
  clearConclusions();

  // ① 参数与生成多项式
  const meta = $('t-meta');
  meta.textContent = '';
  const rows = [
    ['m（域阶数）', String(r.params.m)],
    ['n = 2^m−1（码长）', String(r.params.n)],
    ['t（纠错能力）', String(r.params.t)],
    ['本原多项式（输入串）', r.params.primitiveBits],
    ['生成多项式 g(x)', r.generator.text],
    ['生成多项式比特（高位在前）', r.generator.bits],
    ['deg(g)', String(r.generator.degree)],
    ['k = n − deg(g)（信息位数）', String(r.generator.k)],
  ];
  for (const [k, v] of rows) {
    const tr = el('tr');
    tr.append(el('th', k), el('td', v));
    tr.lastChild.classList.add('mono');
    meta.append(tr);
  }
  $('p-cosets').textContent =
    'g(x) = lcm(M_1, …, M_2t)，由 α 的二倍循环陪集合并得到，共 ' +
    r.generator.cosets.length + ' 个不同陪集：';
  const tbCosets = $('t-cosets');
  tbCosets.textContent = '';
  for (const c of r.generator.cosets) {
    const tr = el('tr');
    tr.append(
      el('td', String(c.rep)),
      el('td', '{' + c.members.join(', ') + '}'),
      el('td', c.minPolyText)
    );
    tr.lastChild.classList.add('mono');
    tbCosets.append(tr);
  }

  // ② 综合症
  const thSyn = $('th-syn');
  const tdSyn = $('td-syn');
  thSyn.textContent = '';
  tdSyn.textContent = '';
  for (const s of r.syndromes) {
    thSyn.append(el('th', 'S_' + s.j));
    tdSyn.append(el('td', s.text));
  }

  // ③ 定位多项式
  $('locator-text').textContent = `Λ(x) = ${r.locator.text}（deg = ${r.locator.degree}）`;
  const tbLoc = $('t-loc');
  tbLoc.textContent = '';
  for (const c of r.locator.coefficients) {
    const tr = el('tr');
    tr.append(el('td', String(c.i)), el('td', c.text));
    tr.lastChild.classList.add('mono');
    tbLoc.append(tr);
  }

  // ④ Chien 根
  const tbRoots = $('t-roots');
  tbRoots.textContent = '';
  if (r.roots.length === 0) {
    const tr = el('tr');
    const td = el('td', '无（综合症全部为零，未检测到错误）');
    td.colSpan = 3;
    tr.append(td);
    tbRoots.append(tr);
  } else {
    for (const root of r.roots) {
      const tr = el('tr');
      tr.append(
        el('td', String(root.power)),
        el('td', root.rootText),
        el('td', `第 ${root.stringIndex1} 位（下标 ${root.stringIndex0}）`)
      );
      tbRoots.append(tr);
    }
  }

  // ⑤ 纠正结果
  const n = r.params.n;
  const flipSet = new Set(r.roots.map((x) => x.stringIndex0));
  function paintCodeword(str) {
    const frag = document.createDocumentFragment();
    for (let i = 0; i < str.length; i++) {
      if (flipSet.has(i)) {
        frag.append(el('mark', str[i]));
      } else {
        frag.append(document.createTextNode(str[i]));
      }
    }
    return frag;
  }
  const inCell = $('cw-in');
  inCell.textContent = '';
  inCell.append(paintCodeword(r.received));
  const outCell = $('cw-out');
  outCell.textContent = '';
  outCell.append(paintCodeword(r.corrected));

  const recheck = $('cw-recheck');
  if (r.errorCount === 0) {
    recheck.textContent = '全部为 0（原码字即合法，未作翻转）';
  } else {
    recheck.textContent = `翻转 ${r.errorCount} 位后重算 S_1…S_${2 * r.params.t}，全部为 0`;
  }
  const badge = $('conclusion-badge');
  badge.textContent = r.errorCount === 0 ? '零错误合法码字' : `已纠正 ${r.errorCount} 位`;
  badge.className = 'badge ok';
  $('conclusion-text').textContent = r.conclusion;

  for (const id of SINGLE_SECTIONS) {
    $(id).classList.add('show');
  }
  setStatus(r.conclusion, 'ok');
}

/* ---------------------------------------------------------------------------
 * 连续帧批量复核
 * ------------------------------------------------------------------------- */

/** 高亮渲染一段比特串；flip 为需要标红的 0 基下标集合，dim 段可置灰。 */
function paintBits(str, flipSet = new Set()) {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < str.length; i++) {
    if (flipSet.has(i)) frag.append(el('mark', str[i]));
    else frag.append(document.createTextNode(str[i]));
  }
  return frag;
}

function renderFrameBlock(block, t) {
  const box = el('div', '');
  box.className = 'panel' + (block.ok ? ' block-ok' : ' block-err');
  box.style.marginBottom = '12px';

  const head = el('h2', '');
  const badge = el('span', '');
  badge.className = 'badge ' + (block.ok ? 'ok' : 'err');
  badge.style.marginLeft = '8px';
  head.append(
    document.createTextNode(
      `第 ${block.ordinal} 块（整帧第 ${block.range.start}–${block.range.end} 位）`
    ),
    badge
  );
  box.append(head);

  if (!block.ok) {
    badge.textContent = '不可采用';
    const p = el('div', block.reason);
    p.style.color = 'var(--err)';
    box.append(p);
    const note = el(
      'p',
      '该块超出纠错能力或定位证据不闭合，本块不给出纠正码字；其余块结果仍完整保留。'
    );
    note.className = 'hint';
    box.append(note);
    return box;
  }

  const r = block.result;
  badge.textContent =
    r.errorCount === 0 ? '零错误合法码字' : `可纠正（${r.errorCount} 位）`;

  // 综合症摘要
  const synLine = r.syndromes
    .map((s) => `S_${s.j}=${s.text}`)
    .join('，');
  const pSyn = el('p', '');
  pSyn.className = 'mono';
  pSyn.style.fontSize = '12.5px';
  pSyn.append(el('strong', '综合症摘要：'), document.createTextNode(synLine));
  box.append(pSyn);

  // 定位多项式与串内错误位置
  const pLoc = el('p', '');
  pLoc.className = 'mono';
  pLoc.style.fontSize = '12.5px';
  pLoc.append(
    el('strong', '定位多项式：'),
    document.createTextNode(`Λ(x) = ${r.locator.text}（deg = ${r.locator.degree}）`)
  );
  box.append(pLoc);

  const pPos = el('p', '');
  if (r.roots.length === 0) {
    pPos.append(el('strong', '串内错误位置：'), document.createTextNode('无（综合症全部为零）'));
  } else {
    const posText = r.roots
      .map(
        (root) =>
          `块内第 ${root.stringIndex1} 位（整帧第 ${block.range.start + root.stringIndex0} 位，x^${root.power}）`
      )
      .join('；');
    pPos.append(el('strong', '串内错误位置：'), document.createTextNode(posText));
  }
  box.append(pPos);

  // 接收 / 纠正码字（错误位高亮）
  const flipSet = new Set(r.roots.map((x) => x.stringIndex0));
  const tbl = el('table');
  const tbody = el('tbody');
  const trIn = el('tr');
  trIn.append(el('th', '块接收串'));
  const tdIn = el('td', '');
  tdIn.className = 'mono codeword';
  tdIn.append(paintBits(r.received, flipSet));
  trIn.append(tdIn);
  const trOut = el('tr');
  trOut.append(el('th', '块纠正串'));
  const tdOut = el('td', '');
  tdOut.className = 'mono codeword';
  tdOut.append(paintBits(r.corrected, flipSet));
  trOut.append(tdOut);
  const trCheck = el('tr');
  trCheck.append(el('th', '纠正后综合症'));
  trCheck.append(
    el(
      'td',
      r.errorCount === 0
        ? '全部为 0（原码字即合法）'
        : `翻转 ${r.errorCount} 位后 S_1…S_${2 * t} 全部为 0`
    )
  );
  trCheck.lastChild.classList.add('mono');
  tbody.append(trIn, trOut, trCheck);
  tbl.append(tbody);
  box.append(tbl);

  const pConc = el('p', r.conclusion);
  pConc.className = 'hint';
  box.append(pConc);
  return box;
}

function renderFrameSuccess(fr) {
  clearConclusions();

  // 参数与生成多项式（整帧共用）
  const meta = $('t-frame-meta');
  meta.textContent = '';
  const rows = [
    ['m（域阶数）', String(fr.params.m)],
    ['n = 2^m−1（每块码长）', String(fr.n)],
    ['t（纠错能力）', String(fr.params.t)],
    ['块数', String(fr.blockCount)],
    ['整帧总长度', `${fr.frame.length} 位（${fr.blockCount} × ${fr.n}）`],
    ['本原多项式（输入串）', fr.params.primitiveBits],
    ['生成多项式 g(x)', fr.generator.text],
    ['deg(g) / k', `${fr.generator.degree} / ${fr.generator.k}`],
  ];
  for (const [k, v] of rows) {
    const tr = el('tr');
    tr.append(el('th', k), el('td', v));
    tr.lastChild.classList.add('mono');
    meta.append(tr);
  }
  $('p-frame-cosets').textContent =
    'g(x) 由 α 的二倍循环陪集合并得到，共 ' + fr.generator.cosets.length + ' 个不同陪集：' +
    fr.generator.cosets.map((c) => `C_${c.rep}={${c.members.join(',')}}`).join('，') +
    `；g(x) = ${fr.generator.text}。`;

  // 整帧裁决
  const verdict = $('frame-verdict');
  verdict.textContent = '';
  const failedBlocks = fr.blocks.filter((b) => !b.ok);
  const banner = el('div', '');
  banner.className = 'frame-banner ' + (fr.allCorrectable ? 'ok' : 'err');
  if (fr.allCorrectable) {
    const totalErrors = fr.blocks.reduce((s, b) => s + b.result.errorCount, 0);
    banner.textContent =
      `整帧可采用：${fr.blockCount} 块全部通过既有复核流程，共纠正 ${totalErrors} 个错误比特，纠正整帧见下。`;
  } else {
    const which = failedBlocks.map((b) => '第 ' + b.ordinal + ' 块').join('、');
    banner.textContent =
      `拒绝整帧采用：${which} 超出纠错能力或定位证据不闭合（共 ${failedBlocks.length} 块）。` +
      '其余块结果如下完整保留，但拼接后的纠正整帧不予给出，整帧不得作为正常数据采用。';
  }
  verdict.append(banner);

  // 逐块结果（按块序）
  const blocksBox = $('frame-blocks');
  blocksBox.textContent = '';
  for (const block of fr.blocks) {
    blocksBox.append(renderFrameBlock(block, fr.params.t));
  }

  // 拼接后的原始整帧（高亮各成功块定位到的错误位）
  const globalFlips = new Set();
  for (const b of fr.blocks) {
    if (!b.ok) continue;
    const start = b.index * fr.n;
    for (const root of b.result.roots) globalFlips.add(start + root.stringIndex0);
  }
  const rawCell = $('frame-raw');
  rawCell.textContent = '';
  rawCell.append(paintBits(fr.frame, globalFlips));

  const rowCorrected = $('row-frame-corrected');
  const rowRejected = $('row-frame-rejected');
  const badge = $('frame-badge');
  if (fr.allCorrectable) {
    rowCorrected.style.display = '';
    rowRejected.style.display = 'none';
    const outCell = $('frame-corrected');
    outCell.textContent = '';
    outCell.append(paintBits(fr.correctedFrame, globalFlips));
    badge.textContent = '整帧可采用';
    badge.className = 'badge ok';
    setStatus(
      `连续帧复核通过：${fr.blockCount} 块全部可纠正，整帧可安全采用。`,
      'ok'
    );
  } else {
    rowCorrected.style.display = 'none';
    rowRejected.style.display = '';
    $('frame-rejected').textContent =
      '整帧拒绝采用（存在不可纠正 / 证据不闭合的块；红色标记仅为成功块内已定位的错误位，不代表整帧可纠正）。';
    $('frame-rejected').style.color = 'var(--err)';
    badge.textContent = '整帧拒绝采用';
    badge.className = 'badge err';
    setStatus(
      `连续帧复核完成但整帧拒绝采用：${failedBlocks.map((b) => '第' + b.ordinal + '块').join('、')} 失败，其余块结果已保留。`,
      'err'
    );
  }

  $('frame-result').classList.add('show');
}

/* ---------------------------------------------------------------------------
 * 运行 / 清空 / 模式切换
 * ------------------------------------------------------------------------- */

function run() {
  if (busy) return;
  mode = currentMode();
  clearConclusions();
  busy = true;
  setButtons();
  createWorker();
  if (mode === 'frame') {
    setStatus('Worker 正在验证参数并逐块执行综合症 / BM / Chien / 纠正后归零裁决 …', 'busy');
    worker.postMessage({
      type: 'analyzeFrame',
      m: $('m').value,
      polyStr: $('poly').value.trim(),
      t: $('t').value,
      blockCount: $('block-count').value.trim(),
      frameStr: $('frame').value.trim(),
    });
  } else {
    setStatus('Worker 正在验证本原多项式、构造生成多项式并执行综合症 / BM / Chien …', 'busy');
    worker.postMessage({
      type: 'analyze',
      m: $('m').value,
      polyStr: $('poly').value.trim(),
      t: $('t').value,
      rStr: $('r').value.trim(),
    });
  }
}

function clearAll() {
  if (worker) worker.terminate();
  worker = null;
  busy = false;
  setButtons();
  for (const id of [...inputs, ...frameInputs]) $(id).value = '';
  clearConclusions();
  $('m').focus();
}

function applyMode() {
  mode = currentMode();
  // 切换模式立即清除上一模式留下的任何成功/失败结论，避免跨模式误用。
  clearConclusions();
  $('single-inputs').style.display = mode === 'single' ? '' : 'none';
  $('frame-inputs').style.display = mode === 'frame' ? '' : 'none';
  setButtons();
}

$('btn-run').addEventListener('click', run);
$('btn-clear').addEventListener('click', clearAll);
for (const id of [...inputs, 'block-count']) {
  $(id).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') run();
  });
}
for (const radio of document.querySelectorAll('input[name="mode"]')) {
  radio.addEventListener('change', applyMode);
}
