'use strict';

/**
 * 记忆星云 Lite — 召回片段（给大脑用的紧凑中文块）
 *
 * 职责：把 recall.js 的四臂召回结果整理成「分层配额 + 总字数预算」的片段列表，
 * 并渲染成 SPEC §4 规定的文本：
 *
 *   以下是与当前问题相关的记忆（供参考，不要逐字复述；无关就别硬提）：
 *   · [画像] 你叫李雷；你在杭州（重要 0.95）
 *   · [事实] 用户喜欢喝手冲咖啡（3 天前）
 *   · [联想] 用户用 VS Code 当主力编辑器（因为提到「编辑器」联想到）
 *
 * 分层配额：profile 3 / fact 4 / note 2 / event 2 / association 2，总长 ≤ 1400 字。
 * 超预算时从「非画像、分数最低」的条目开始丢，保证画像永远在最前面。
 */

const dyn = require('./dynamics.cjs');

const { num, clamp, round, charLen, truncateChars } = dyn;

const DEFAULT_BUDGET = 1400;
const DEFAULT_TOP_K = 8;
const QUOTA = Object.freeze({ profile: 3, fact: 4, note: 2, event: 2, association: 2 });
const ORDER = Object.freeze(['profile', 'fact', 'note', 'event', 'association']);
const LABEL = Object.freeze({
  profile: '画像',
  fact: '事实',
  note: '记住',
  event: '对话',
  association: '联想',
});
const HEADER = '以下是与当前问题相关的记忆（供参考，不要逐字复述；无关就别硬提）：';
const DAY_MS = 86400000;

/** 条目落在哪个分层桶里（draws 配额 & 标签） */
function bucketOf(entry) {
  if (entry.arm === 'profile' || (entry.arms && entry.arms.profile)) return 'profile';
  if (entry.arm === 'graph' && entry.hop > 0) return 'association';
  const node = entry.node;
  const layer = dyn.layerOf(node.kind, node.layer);
  if (node.kind === 'profile' || layer === dyn.LAYER.SUMMARY) return 'profile';
  if (node.kind === 'fact') return 'fact';
  if (node.kind === 'note') return 'note';
  if (node.kind === 'episode' || layer === dyn.LAYER.EVENT) return 'event';
  return 'fact';
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / N 个月前 / N 年前 */
function ageText(ts, now = Date.now()) {
  const ms = Math.max(0, now - num(ts, now));
  if (ms < 60000) return '刚刚';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(ms / 3600000);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(ms / DAY_MS);
  if (days < 30) return `${days} 天前`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} 个月前`;
  return `${Math.floor(days / 365)} 年前`;
}

/** 单行文本（`· [标签] 正文（后缀）`） */
function lineFor(entry, query, mem, now) {
  const label = LABEL[entry.bucket] || '记忆';
  const body = truncateChars(entry.node.text, 160);
  let suffix;
  if (entry.bucket === 'profile') {
    suffix = `重要 ${num(entry.node.importance, 0.5).toFixed(2)}`;
  } else if (entry.bucket === 'association') {
    const viaNode = entry.via ? mem.nodes.get(entry.via) : null;
    const viaText = viaNode ? viaNode.text : '';
    const queryText = query && charLen(query) <= 20 ? query : '';
    const keyword = queryText || viaText;
    suffix = keyword ? `因为提到「${truncateChars(keyword, 18)}」联想到` : '联想';
  } else {
    suffix = ageText(entry.node.ts, now);
  }
  return `· [${label}] ${body}（${suffix}）`;
}

/**
 * 组装片段视图。
 *
 * @param {{mem:any, query:string, recall:any, topK?:number, budgetChars?:number, now?:number}} args
 * @returns {{fragments:Array<any>, byLayer:Object, text:string, dropped:number, chars:number}}
 */
function buildFragment(args) {
  const { mem, query, recall } = args;
  const now = num(args.now, Date.now());
  const budgetChars = clamp(Math.floor(num(args.budgetChars, DEFAULT_BUDGET)), 200, 4000);
  const topK = clamp(Math.floor(num(args.topK, DEFAULT_TOP_K)), 1, 30);

  // 1) 分层配额
  /** @type {Record<string, any[]>} */
  const byBucket = { profile: [], fact: [], note: [], event: [], association: [] };
  for (const entry of recall.picked) {
    entry.bucket = bucketOf(entry);
    byBucket[entry.bucket].push(entry);
  }
  /** @type {any[]} */
  let kept = [];
  for (const bucket of ORDER) {
    const list = byBucket[bucket].slice().sort((a, b) => b.score - a.score);
    for (const entry of list.slice(0, QUOTA[bucket])) kept.push(entry);
  }
  kept = kept.slice(0, topK);

  // 2) 预算：总长 ≤ budgetChars（含标题），超了从「非画像、分最低」开始丢
  const render = (list) =>
    HEADER + (list.length ? '\n' + list.map((e) => lineFor(e, query, mem, now)).join('\n') : '');
  let text = render(kept);
  let removed = 0;
  while (charLen(text) > budgetChars && kept.length > 1) {
    let idx = -1;
    let min = Infinity;
    for (let i = 0; i < kept.length; i++) {
      if (kept[i].bucket === 'profile') continue;
      if (kept[i].score < min) {
        min = kept[i].score;
        idx = i;
      }
    }
    if (idx < 0) break;
    kept.splice(idx, 1);
    removed++;
    text = render(kept);
  }
  if (charLen(text) > budgetChars) text = truncateChars(text, budgetChars);

  // 3) 输出结构
  const fragments = kept.map((entry) => ({
    id: entry.id,
    layer: dyn.layerOf(entry.node.kind, entry.node.layer),
    kind: entry.node.kind,
    text: entry.node.text,
    score: round(entry.score, 4),
    arm: entry.arm,
    hop: entry.arm === 'graph' ? clamp(num(entry.hop, 0), 0, 2) : 0,
    why: entry.why,
    importance: round(num(entry.node.importance, 0.5), 3),
    retention: round(num(entry.recency, 0), 4),
  }));
  const byLayer = { profile: [], fact: [], note: [], event: [], association: [] };
  for (const entry of kept) byLayer[entry.bucket].push(entry.id);

  return {
    fragments,
    byLayer,
    text,
    dropped: Math.max(0, recall.dropped + removed),
    chars: charLen(text),
  };
}

module.exports = {
  DEFAULT_BUDGET,
  DEFAULT_TOP_K,
  QUOTA,
  ORDER,
  LABEL,
  HEADER,
  bucketOf,
  ageText,
  lineFor,
  buildFragment,
};
