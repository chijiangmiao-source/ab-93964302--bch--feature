// worker.js — 浏览器端复核 Worker（module worker），与 Node 测试共用 src/ 下同一份核心。
// 单码字（analyze）与连续整帧批量（analyzeFrame）共用同一套 BCH 复核规则。
import { analyzeBch, analyzeFrame } from './lib/bch.js';

self.onmessage = (e) => {
  const msg = e.data || {};
  try {
    if (msg.type === 'analyze') {
      const result = analyzeBch({
        m: Number(msg.m),
        polyStr: String(msg.polyStr ?? ''),
        t: Number(msg.t),
        rStr: String(msg.rStr ?? ''),
      });
      self.postMessage({ type: 'result', result });
      return;
    }
    if (msg.type === 'analyzeFrame') {
      const result = analyzeFrame({
        m: Number(msg.m),
        polyStr: String(msg.polyStr ?? ''),
        t: Number(msg.t),
        frameStr: String(msg.frameStr ?? ''),
        blockCount: msg.blockCount, // 原始输入交给核心校验，错误信息可回显原始内容
      });
      self.postMessage({ type: 'frameResult', result });
      return;
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
};
