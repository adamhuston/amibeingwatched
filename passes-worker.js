import { findNextOverheadPass } from './passes.js';

self.onmessage = ({ data: { sats, observerGd } }) => {
  const computedAt = Date.now();
  try {
    self.postMessage({ result: findNextOverheadPass(sats, observerGd), computedAt });
  } catch (err) {
    self.postMessage({ error: err.message });
  }
};
