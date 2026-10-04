// app.js — 页面交互：把输入交给 Worker，渲染证据；失败时稳定清除旧成功证据。

const $ = (id) => document.getElementById(id);
const inputs = ['m', 'poly', 't', 'r'];

let worker = null;
let busy = false;

function createWorker() {
  if (worker) worker.terminate();
  worker = new Worker('./worker.js', { type: 'module' });
  worker.onmessage = (e) => {
    busy = false;
    setButtons();
    const msg = e.data || {};
    if (msg.type === 'result') renderSuccess(msg.result);
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

/** 清除一切旧结论（成功证据与失败提示同时清空）。 */
function clearConclusions() {
  for (const id of ['result', 'result2', 'result3', 'result4', 'result5']) {
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

  for (const id of ['result', 'result2', 'result3', 'result4', 'result5']) {
    $(id).classList.add('show');
  }
  setStatus(r.conclusion, 'ok');
}

function run() {
  if (busy) return;
  clearConclusions();
  busy = true;
  setButtons();
  setStatus('Worker 正在验证本原多项式、构造生成多项式并执行综合症 / BM / Chien …', 'busy');
  createWorker();
  worker.postMessage({
    type: 'analyze',
    m: $('m').value,
    polyStr: $('poly').value.trim(),
    t: $('t').value,
    rStr: $('r').value.trim(),
  });
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

$('btn-run').addEventListener('click', run);
$('btn-clear').addEventListener('click', clearAll);
for (const id of inputs) {
  $(id).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') run();
  });
}
