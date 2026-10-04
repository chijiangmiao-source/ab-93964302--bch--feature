// worker.js — 浏览器端复核 Worker（module worker），与 Node 测试共用 src/ 下同一份核心。
// 支持：
//   type:'analyze'       单码字复核（analyzeBch）
//   type:'analyzeFrame' 连续帧批量复核（analyzeBchFrame，逐块走同一复核流程）
import { analyzeBch, analyzeBchFrame } from './lib/bch.js';

self.onmessage = (e) => {
  const msg = e.data || {};
  try {
    if (msg.type === 'analyzeFrame') {
      // 粘贴的整帧可能带换行/空格：边界处剔除全部空白字符后再交核心严格校验。
      const frameStr = String(msg.frameStr ?? '').replace(/\s+/g, '');
      const result = analyzeBchFrame({
        m: Number(msg.m),
        polyStr: String(msg.polyStr ?? ''),
        t: Number(msg.t),
        blockCount: msg.blockCount === '' || msg.blockCount === null || msg.blockCount === undefined
          ? NaN
          : Number(msg.blockCount),
        frameStr,
      });
      self.postMessage({ type: 'frameResult', result });
      return;
    }
    if (msg.type !== 'analyze') return;
    const result = analyzeBch({
      m: Number(msg.m),
      polyStr: String(msg.polyStr ?? ''),
      t: Number(msg.t),
      rStr: String(msg.rStr ?? ''),
    });
    self.postMessage({ type: 'result', result });
  } catch (err) {
    self.postMessage({
      type: 'error',
      scope: msg.type === 'analyzeFrame' ? 'frame' : 'single',
      message: err && err.message ? err.message : String(err),
    });
  }
};
