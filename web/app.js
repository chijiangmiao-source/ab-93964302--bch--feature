// app.js — 页面交互：单码字与连续整帧批量两种模式，共用同一 Worker 与同一套核心规则。
// 任何一次复核先清除旧结论；失败时稳定清除旧成功证据，绝不残留上一次的可采用结论。

const $ = (id) => document.getElementById(id);
const inputs = ['m', 'poly', 't', 'r', 'blk-count', 'frame-bits'];
const SINGLE_PANELS = ['result', 'result2', 'result3', 'result4', 'result5'];
const FRAME_PANELS = ['frame-result', 'frame-blocks', 'frame-concat'];

let worker = null;
let busy = false;

function currentMode() {
  const checked = document.querySelector('input[name="mode"]:checked');
  return checked ? checked.value : 'single';
}

function createWorker() {
  if (worker) worker.terminate();
  worker = new Worker('./worker.js', { type: 'module' });
  worker.onmessage = (e) => {
    busy = false;
    setButtons();
    const msg = e.data || {};
    if (msg.type === 'result') renderSuccess(msg.result);
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
  $('btn-run').textContent = busy ? '复核中…' : '复核';
}

function setStatus(text, cls) {
  const el = $('status');
  el.textContent = text;
  el.className = cls || '';
}

/** 清除一切旧结论（单码字证据、整帧结论与失败提示同时清空）。 */
function clearConclusions() {
  for (const id of [...SINGLE_PANELS, ...FRAME_PANELS]) {
    $(id).classList.remove('show');
  }
  $('blocks-container').textContent = '';
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

/** 把比特串渲染成带翻转高亮的片段；flipSet 为串内 0 基下标集合。 */
function paintBits(str, flipSet) {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < str.length; i++) {
    if (flipSet && flipSet.has(i)) {
      frag.append(el('mark', str[i]));
    } else {
      frag.append(document.createTextNode(str[i]));
    }
  }
  return frag;
}

/* ---------------- 单码字模式 ---------------- */

function renderSuccess(r) {
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
    'g(x) = lcm(M_1, …, M_{2t})，由 α 的二倍循环陪集合并得到，共 ' +
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
  const flipSet = new Set(r.roots.map((x) => x.stringIndex0));
  const inCell = $('cw-in');
  inCell.textContent = '';
  inCell.append(paintBits(r.received, flipSet));
  const outCell = $('cw-out');
  outCell.textContent = '';
  outCell.append(paintBits(r.corrected, flipSet));

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

  for (const id of SINGLE_PANELS) $(id).classList.add('show');
  setStatus(r.conclusion, 'ok');
}

/* ---------------- 连续整帧批量模式 ---------------- */

function renderFrameSuccess(fr) {
  clearConclusions();

  // 整帧结论与共享参数
  const meta = $('t-frame-meta');
  meta.textContent = '';
  const rows = [
    ['m（域阶数）', String(fr.params.m)],
    ['n = 2^m−1（单块码长）', String(fr.params.n)],
    ['t（纠错能力）', String(fr.params.t)],
    ['本原多项式（输入串）', fr.params.primitiveBits],
    ['生成多项式 g(x)', fr.generator.text],
    ['deg(g) / k', `${fr.generator.degree} / ${fr.generator.k}`],
    ['块数 B', String(fr.params.blockCount)],
    ['整帧总长度', `${fr.params.totalLength} 位（${fr.params.blockCount} × ${fr.params.n}）`],
    ['整帧错误比特总数', String(fr.totalErrors)],
  ];
  for (const [k, v] of rows) {
    const tr = el('tr');
    tr.append(el('th', k), el('td', v));
    tr.lastChild.classList.add('mono');
    meta.append(tr);
  }
  const badge = $('frame-badge');
  badge.textContent = fr.adopted ? '整帧可采用' : '拒绝整帧采用';
  badge.className = fr.adopted ? 'badge ok' : 'badge err';
  $('frame-conclusion').textContent = fr.conclusion;
  $('frame-result').classList.add('show');

  // 逐块明细（按块序；失败块保留其余块结果）
  const container = $('blocks-container');
  container.textContent = '';
  for (const blk of fr.blocks) {
    const i = blk.index;
    const range = `整帧比特 ${i * fr.params.n + 1}–${(i + 1) * fr.params.n}`;
    const panel = el('div');
    panel.className = 'block-panel' + (blk.ok ? '' : ' bad');

    const h3 = el('h3');
    h3.append(document.createTextNode(`第 ${i + 1} 块 `));
    const rng = el('span', `（${range}）`);
    rng.className = 'rng';
    h3.append(rng, document.createTextNode(' '));
    const bBadge = el('span');
    if (blk.ok) {
      bBadge.className = 'badge ok';
      bBadge.textContent = blk.result.errorCount === 0
        ? '零错误合法码字'
        : `已纠正 ${blk.result.errorCount} 位`;
    } else {
      bBadge.className = 'badge err';
      bBadge.textContent = '未通过';
    }
    h3.append(bBadge);
    panel.append(h3);

    if (blk.ok) {
      const r = blk.result;
      const syn = el('div');
      syn.className = 'kv mono';
      syn.append(
        el('span', '综合症摘要：'),
        document.createTextNode(r.syndromes.map((s) => `S_${s.j}=${s.text}`).join('，'))
      );
      syn.firstChild.className = 'k';
      panel.append(syn);

      const loc = el('div');
      loc.className = 'kv';
      loc.append(el('span', '错误位置（串内）：'));
      loc.firstChild.className = 'k';
      if (r.roots.length === 0) {
        loc.append(document.createTextNode('无（未检测到错误）'));
      } else {
        loc.append(document.createTextNode(
          r.roots
            .map((x) => `块内第 ${x.stringIndex1} 位（x^${x.power}，整帧第 ${x.frameIndex1} 位）`)
            .join('；')
        ));
      }
      panel.append(loc);

      const flipSet = new Set(r.roots.map((x) => x.stringIndex0));
      const cwIn = el('div');
      cwIn.className = 'kv';
      cwIn.append(el('span', '接收码字：'));
      cwIn.firstChild.className = 'k';
      const inBits = el('span');
      inBits.className = 'codeword';
      inBits.append(paintBits(r.received, flipSet));
      cwIn.append(inBits);
      panel.append(cwIn);

      const cwOut = el('div');
      cwOut.className = 'kv';
      cwOut.append(el('span', '纠正码字：'));
      cwOut.firstChild.className = 'k';
      const outBits = el('span');
      outBits.className = 'codeword';
      outBits.append(paintBits(r.corrected, flipSet));
      cwOut.append(outBits);
      panel.append(cwOut);

      const note = el('div', r.conclusion);
      note.className = 'kv';
      panel.append(note);
    } else {
      const errLine = el('div', `失败原因：${blk.error}`);
      errLine.className = 'err-text';
      panel.append(errLine);
      const cwIn = el('div');
      cwIn.className = 'kv';
      cwIn.append(el('span', '接收码字（保持原样，不作任何伪装纠正）：'));
      cwIn.firstChild.className = 'k';
      const inBits = el('span');
      inBits.className = 'codeword';
      inBits.append(paintBits(blk.received, null));
      cwIn.append(inBits);
      panel.append(cwIn);
    }
    container.append(panel);
  }
  $('frame-blocks').classList.add('show');

  // 拼接整帧：原始整帧始终展示；纠正整帧仅在整帧可采用时给出。
  const flipFrame = new Set();
  for (const blk of fr.blocks) {
    if (!blk.ok) continue;
    for (const root of blk.result.roots) flipFrame.add(root.frameIndex0);
  }
  const n = fr.params.n;
  function paintFrame(str) {
    const frag = document.createDocumentFragment();
    for (let b = 0; b < fr.params.blockCount; b++) {
      const span = el('span');
      span.className = 'blk';
      // 块内高亮：把整帧全局下标换算到块内
      const local = new Set();
      for (const idx of flipFrame) {
        if (idx >= b * n && idx < (b + 1) * n) local.add(idx - b * n);
      }
      span.append(paintBits(str.slice(b * n, (b + 1) * n), local));
      frag.append(span);
    }
    return frag;
  }
  const frameIn = $('frame-in');
  frameIn.textContent = '';
  frameIn.append(paintFrame(fr.frameReceived));
  const rowOut = $('row-frame-out');
  const hint = $('frame-concat-hint');
  if (fr.adopted) {
    rowOut.classList.remove('hidden');
    const frameOut = $('frame-out');
    frameOut.textContent = '';
    frameOut.append(paintFrame(fr.frameCorrected));
    hint.textContent =
      `虚线为块界（每 ${n} 位一块，共 ${fr.params.blockCount} 块）；红色为被翻转的比特。`;
  } else {
    rowOut.classList.add('hidden');
    hint.textContent =
      '存在未通过复核的块，不提供拼接纠正整帧；请先在上方逐块明细中处理失败块后重新下传。';
  }
  $('frame-concat').classList.add('show');

  setStatus(fr.conclusion, fr.adopted ? 'ok' : 'err');
}

/* ---------------- 交互 ---------------- */

function run() {
  if (busy) return;
  clearConclusions();
  busy = true;
  setButtons();
  createWorker();
  if (currentMode() === 'frame') {
    setStatus('Worker 正在验证共享参数，并按当前码长切分整帧、逐块执行综合症 / BM / Chien …', 'busy');
    worker.postMessage({
      type: 'analyzeFrame',
      m: $('m').value,
      polyStr: $('poly').value.trim(),
      t: $('t').value,
      frameStr: $('frame-bits').value.trim(),
      blockCount: $('blk-count').value.trim(),
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
  for (const id of inputs) $(id).value = '';
  clearConclusions();
  $('m').focus();
}

/** 模式切换：仅切换输入区并清除旧结论（另一模式的结论不得残留），草稿保留。 */
function switchMode() {
  const frame = currentMode() === 'frame';
  $('lbl-r').classList.toggle('hidden', frame);
  $('row-r').classList.toggle('hidden', frame);
  $('lbl-frame').classList.toggle('hidden', !frame);
  $('row-frame').classList.toggle('hidden', !frame);
  clearConclusions();
}

$('btn-run').addEventListener('click', run);
$('btn-clear').addEventListener('click', clearAll);
for (const radio of document.querySelectorAll('input[name="mode"]')) {
  radio.addEventListener('change', switchMode);
}
for (const id of inputs) {
  $(id).addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && id !== 'frame-bits') run();
  });
}
