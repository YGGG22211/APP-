'use strict';
/** 简化版 SM-2 间隔重复算法 */

const BASE = [1, 3, 7]; // 天：第 1/2/3 次复习的固定间隔
const MAX_INTERVAL = 180;

/**
 * @param word 词对象 {interval, reps, ef}
 * @param grade 0 完全忘记 / 1 模糊 / 2 记住
 */
function sm2Update(word, grade) {
  let { interval = 0, reps = 0, ef = 2.5 } = word;
  if (grade <= 0) { reps = 0; interval = 1; ef = Math.max(1.3, ef - 0.2); }
  else {
    if (grade === 1) ef = Math.max(1.3, ef - 0.05);
    if (reps < BASE.length) interval = BASE[reps];
    else interval = Math.min(MAX_INTERVAL, Math.round(interval * ef));
    reps += 1;
  }
  const dueAt = new Date(Date.now() + interval * 86400000).toISOString();
  return { interval, reps, ef, dueAt };
}

module.exports = { sm2Update };
