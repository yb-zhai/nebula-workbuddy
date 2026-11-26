'use strict';

/**
 * 记忆星云 Lite — 动力学层（S 状态 / FSRS 遗忘 / 归档 / 赫布边 / L3 摘要）
 *
 * 公式与参考实现 brain_dynamics.py 对齐（纯 JS、无外部依赖）：
 *   - 可提取度：R = exp(-Δt / S)，S 是 stability（天），Δt 从 lastAccessAt 算起；
 *   - touch：S' = S · (1 + 1.5 · (1 - R))，lastAccessAt = now，access++，act 写回；
 *   - 归档：R < 0.15 且 Δt > 90 天 → archived=true（只归档、不删除，includeArchived 仍可召回）；
 *   - 赫布边：共激活对 w += η · aᵢ · aⱼ · (1 - w)，η=0.02，(1-w) 上界防正反馈失控；
 *   - 合成边（只削 hebbian，不动人工/semantic 边）：60 天未触发 ×0.9，w < 0.01 删除；
 *   - 每节点 hebbian 边数上限（默认 16）：超出按保留分 w×log2(1+触发) 剪最弱，图增长有界；
 *   - L3 摘要：确定性模板「你叫…／你在…／你偏好…／最近在忙…」，不用 LLM。
 *
 * 本模块不 require store（避免循环依赖）：所有记忆操作都通过传入的 mem 实例完成，
 * mem 需要提供 store.js 里的内部方法（_queuePersist / _addEdge / _updateEdge /
 * _removeEdge / _rewriteNode / _insertNode / _buildRecord / _log 等）。
 */

const DAY_MS = 86400000;

/** 分层（与 nodes.jsonl 的 layer 字段一一对应） */
const LAYER = Object.freeze({
  EVENT: 'event', // L0 事件：一轮对话的原始文本
  FRAGMENT: 'fragment', // L1 片段：从对话里抽出来的事实/画像/显式记忆
  SUMMARY: 'summary', // L3 摘要：跨片段的画像性总结
});

/** 边类型（edges.jsonl 的 kind 字段） */
const EDGE_KIND = Object.freeze({
  SEMANTIC: 'semantic', // 语义相似 / 巩固时连出来的边（默认）
  HEBBIAN: 'hebbian', // 同一次召回里共激活形成的合成边
  EXPLICIT: 'explicit', // 调用方显式 link() 出来的边
});

/**
 * MEM_KIND 里没有 summary（constants.js 归 Lead 维护，我不能改），
 * 这里用本地常量兜底；kind 仍然是 'summary'，与 SPEC 一致。
 */
const SUMMARY_KIND = 'summary';
const SUMMARY_META_KEY = 'l3-profile';

// ---------------------------------------------------------------------------
// 小工具（各模块自带一份，避免为了 3 个函数再开一个文件）
// ---------------------------------------------------------------------------

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** 读实例参数：优先 NebulaMemory.opts（构造时的 weights 也在这里），兼容直接挂在实例上的旧写法 */
function opt(mem, key, fallback) {
  if (mem) {
    if (mem.opts && mem.opts[key] != null) return mem.opts[key];
    if (mem[key] != null) return mem[key];
  }
  return fallback;
}

function clamp(n, lo, hi) {
  return n < lo ? lo : n > hi ? hi : n;
}

function clamp01(n) {
  return clamp(num(n, 0), 0, 1);
}

function round(n, digits = 4) {
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

function charLen(s) {
  return Array.from(String(s == null ? '' : s)).length;
}

function truncateChars(s, max) {
  const arr = Array.from(String(s == null ? '' : s));
  if (arr.length <= max) return arr.join('');
  return arr.slice(0, Math.max(0, max - 1)).join('') + '…';
}

function trimPunct(s) {
  return String(s == null ? '' : s).replace(/^[\s，。、；：,.;:!?！？"'“”‘’（）()【】[\]「」]+|[\s，。、；：,.;:!?！？"'“”‘’（）()【】[\]「」]+$/gu, '');
}

// ---------------------------------------------------------------------------
// S 状态：可提取度 / 分层
// ---------------------------------------------------------------------------

/** stability 默认 1 天；下限 0.05 天，上限 10 年，避免除零与无限增长 */
function stabilityOf(node) {
  return clamp(num(node && node.stability, 1), 0.05, 3650);
}

/** 最近一次访问时间（没有就用创建时间） */
function lastAccessAt(node) {
  return num(node && node.lastAccessAt, num(node && node.ts, Date.now()));
}

function ageDays(node, now = Date.now()) {
  return Math.max(0, (now - lastAccessAt(node)) / DAY_MS);
}

/** FSRS 遗忘曲线：R = exp(-Δt / S)，落在 [0,1]。
 *  importance 满值（≥1.0）视为「置顶/永久事实」（如用户 API 密钥、称呼偏好），
 *  不受时间衰减影响，永远可提取 —— 这是「置顶记忆不遗忘」的语义入口：
 *  抽取层/写入方把关键事实的 importance 设为 1.0 即自动永固，无需额外字段。 */
function retention(node, now = Date.now()) {
  if (node && clamp01(num(node.importance, 0)) >= 1) return 1;
  return clamp01(Math.exp(-ageDays(node, now) / stabilityOf(node)));
}

/**
 * 由 kind + 显式 layer 推断分层（旧数据没有 layer 字段时也能平滑升级）。
 * @param {string} kind
 * @param {string} [layer]
 */
function layerOf(kind, layer) {
  if (layer === LAYER.EVENT || layer === LAYER.FRAGMENT || layer === LAYER.SUMMARY) return layer;
  if (kind === SUMMARY_KIND) return LAYER.SUMMARY;
  if (kind === 'episode') return LAYER.EVENT;
  return LAYER.FRAGMENT;
}

function isValidEdgeKind(kind) {
  return kind === EDGE_KIND.SEMANTIC || kind === EDGE_KIND.HEBBIAN || kind === EDGE_KIND.EXPLICIT;
}

// ---------------------------------------------------------------------------
// touch：命中一次记忆
// ---------------------------------------------------------------------------

/**
 * 更新一条被召回节点的 S 状态（FSRS）。
 * 注意：这里**不再**给 importance 加固定值（v1 的 accessBoost 已废弃），
 * 记忆的「重要性」由抽取阶段决定，访问只影响可提取度。
 *
 * @param {any} mem NebulaMemory 实例
 * @param {any} node 内部节点（有 stability / lastAccessAt / access 字段）
 * @param {{now?:number, act?:number, persist?:boolean}} [opts]
 * @returns {{retention:number, stability:number}}
 */
function touchNode(mem, node, opts = {}) {
  if (!node) return { retention: 0, stability: 1 };
  const now = num(opts.now, Date.now());
  const r = retention(node, now);
  const s = stabilityOf(node);
  node.stability = round(clamp(s * (1 + 1.5 * (1 - r)), 0.05, 3650), 4);
  node.lastAccessAt = now;
  node.access = num(node.access, 0) + 1;
  node.dormant = false;
  if (opts.act != null) {
    node.act = clamp01(opts.act);
    node.actAt = now;
  }
  if (opts.persist !== false && typeof mem._queuePersist === 'function') mem._queuePersist(node);
  return { retention: round(r, 4), stability: node.stability };
}

// ---------------------------------------------------------------------------
// 赫布边：同一次召回内共激活 → 连边 / 强化
// ---------------------------------------------------------------------------

/**
 * @param {any} mem
 * @param {Map<string, number>|Object} acts id → 激活量（0..1，未归一也行）
 * @param {{now?:number, eta?:number, minProduct?:number, minAct?:number,
 *          initWeight?:number, maxPairs?:number, source?:string}} [opts]
 * @returns {{created:number, reinforced:number, pairs:number}}
 */
function applyHebbian(mem, acts, opts = {}) {
  const now = num(opts.now, Date.now());
  const eta = num(opts.eta, num(opt(mem, 'hebbEta'), 0.02));
  const minProduct = num(opts.minProduct, num(opt(mem, 'hebbMinProduct'), 0.3));
  const minAct = num(opts.minAct, 0.2);
  const initWeight = num(opts.initWeight, num(opt(mem, 'hebbNewWeight'), 0.1));
  const maxPairs = Math.max(1, Math.floor(num(opts.maxPairs, 60)));

  const pairsIn = acts instanceof Map ? Array.from(acts.entries()) : Object.entries(acts || {});
  const list = [];
  for (const [id, raw] of pairsIn) {
    const node = mem.nodes.get(String(id));
    if (!node || node.deleted) continue;
    const a = num(raw, 0);
    if (a >= minAct) list.push([node.id, a]);
  }
  let maxA = 0;
  for (const [, a] of list) if (a > maxA) maxA = a;
  if (maxA <= 0 || list.length < 2) return { created: 0, reinforced: 0, pairs: 0 };

  // 先按本轮最大值归一到 0..1（参考实现的 _norm）
  const normed = list.map(([id, a]) => [id, clamp01(a / maxA)]);
  let created = 0;
  let reinforced = 0;
  let pairs = 0;
  for (let i = 0; i < normed.length && pairs < maxPairs; i++) {
    for (let j = i + 1; j < normed.length && pairs < maxPairs; j++) {
      const product = normed[i][1] * normed[j][1];
      if (product < minProduct) continue;
      pairs++;
      const aId = normed[i][0];
      const bId = normed[j][0];
      const key = mem._edgeKey(aId, bId);
      const edge = mem.edgeMap.get(key);
      if (edge) {
        const w = Math.min(1, num(edge.w, 0) + eta * product * (1 - num(edge.w, 0)));
        mem._updateEdge(edge, { w: round(w, 4), lastFired: now, fireCount: num(edge.fireCount, 0) + 1 });
        reinforced++;
      } else {
        mem._addEdge(aId, bId, initWeight, {
          kind: EDGE_KIND.HEBBIAN,
          lastFired: now,
          fireCount: 1,
          source: opts.source || 'recall',
        });
        created++;
      }
    }
  }
  // 每节点赫布边数上限：本轮触碰过的节点立即检查，防写突发期间超限膨胀
  if (created + reinforced > 0) {
    pruneHebbianFor(mem, normed.map(([id]) => id));
  }
  return { created, reinforced, pairs };
}

/** 节点视角的赫布边保留分：权重 × log2(1+触发次数)，同分保新。分值由边自身属性决定，两端视角一致。 */
function hebbianRank(e) {
  return num(e.w, 0) * Math.log2(1 + num(e.fireCount, 0)) + num(e.lastFired, 0) / 1e15;
}

/**
 * 每节点赫布边数上限：超出 maxPerNode 的按保留分剪最弱边。
 * 防止热点节点「每次召回共激活就加边」导致合成边无限累积、图结构漂移。
 * maxPerNode <= 0 = 关闭。走 mem._removeEdge（tombstone 落盘，重启不复活）。
 * @returns {{pruned:number, checked:number, dryRun:boolean}}
 */
function pruneHebbianFor(mem, ids, opts = {}) {
  const maxPerNode = Math.floor(num(opts.maxPerNode, num(opt(mem, 'hebbianMaxPerNode'), 16)));
  const dryRun = opts.dryRun === true;
  if (maxPerNode <= 0) return { pruned: 0, checked: 0, dryRun };
  let pruned = 0;
  let checked = 0;
  const seen = new Set();
  for (const rawId of ids || []) {
    const id = String(rawId);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const adj = mem.adj ? mem.adj.get(id) : null;
    if (!adj || adj.size <= maxPerNode) continue;   // 邻居总数都不超限，必无赫布超限
    const hebb = [];
    for (const other of adj.keys()) {
      const edge = mem.edgeMap.get(mem._edgeKey(id, other));
      if (!edge || edge.deleted) continue;
      if ((edge.kind || EDGE_KIND.SEMANTIC) !== EDGE_KIND.HEBBIAN) continue;
      hebb.push(edge);
    }
    checked++;
    if (hebb.length <= maxPerNode) continue;
    hebb.sort((x, y) => hebbianRank(y) - hebbianRank(x));
    for (const e of hebb.slice(maxPerNode)) {
      if (!dryRun) mem._removeEdge(e);
      pruned++;
    }
  }
  return { pruned, checked, dryRun };
}

// ---------------------------------------------------------------------------
// 遗忘 / 修剪（tick）
// ---------------------------------------------------------------------------

/**
 * 一次遗忘扫描：
 *  1) R < archiveRetention（0.15）且闲置 > archiveMinDays（90 天）→ archived=true（不删）；
 *  2) 合成边（hebbian）闲置 > synapseIdleDays（60 天）→ w *= 0.9，w < 0.01 删除。
 * dryRun=true 时只统计不落盘。
 *
 * @param {any} mem
 * @param {{now?:number, dryRun?:boolean, archiveRetention?:number, archiveMinDays?:number}} [opts]
 * @returns {{archived:number, edgesDecayed:number, edgesRemoved:number, scanned:number, dryRun:boolean}}
 */
function forgetPass(mem, opts = {}) {
  const now = num(opts.now, Date.now());
  const dryRun = opts.dryRun === true;
  const archiveRetention = clamp(num(opts.archiveRetention, num(opt(mem, 'archiveRetention'), 0.15)), 0.01, 0.9);
  const archiveMinDays = Math.max(1, num(opts.archiveMinDays, num(opt(mem, 'archiveMinDays'), 90)));
  const synapseIdleDays = Math.max(1, num(opts.synapseIdleDays, num(opt(mem, 'synapseIdleDays'), 60)));
  const synapseDecay = clamp(num(opts.synapseDecay, num(opt(mem, 'synapseDecay'), 0.9)), 0.1, 0.99);
  const synapseMinWeight = clamp(num(opts.synapseMinWeight, num(opt(mem, 'synapseMinWeight'), 0.01)), 0.0001, 0.5);

  let archived = 0;
  let scanned = 0;
  for (const node of mem.nodes.values()) {
    if (node.deleted) continue;
    scanned++;
    if (node.archived) continue;
    const days = ageDays(node, now);
    if (days < archiveMinDays) continue;
    if (retention(node, now) >= archiveRetention) continue;
    archived++;
    if (!dryRun) {
      node.archived = true;
      node.archivedAt = now;
      mem._queuePersist(node);
    }
  }

  let edgesDecayed = 0;
  let edgesRemoved = 0;
  for (const edge of Array.from(mem.edgeMap.values())) {
    // 只修剪「合成边」；人工 link / 巩固生成的 semantic 边不动
    if ((edge.kind || EDGE_KIND.SEMANTIC) !== EDGE_KIND.HEBBIAN) continue;
    const idle = (now - num(edge.lastFired, num(edge.ts, now))) / DAY_MS;
    if (idle < synapseIdleDays) continue;
    const w = num(edge.w, 0) * synapseDecay;
    if (w < synapseMinWeight) {
      edgesRemoved++;
      if (!dryRun) mem._removeEdge(edge);
    } else {
      edgesDecayed++;
      if (!dryRun) mem._updateEdge(edge, { w: round(w, 4), lastFired: now });
    }
  }

  // 每节点赫布边数上限：衰减后全量扫描一遍，热点节点的合成边超限即按保留分剪最弱
  const maxPerNode = Math.floor(num(opts.maxPerNode, num(opt(mem, 'hebbianMaxPerNode'), 16)));
  let hebbianPruned = 0;
  if (maxPerNode > 0) {
    const byNode = new Map();
    for (const edge of mem.edgeMap.values()) {
      if ((edge.kind || EDGE_KIND.SEMANTIC) !== EDGE_KIND.HEBBIAN) continue;
      if (!byNode.has(edge.a)) byNode.set(edge.a, []);
      byNode.get(edge.a).push(edge);
      if (!byNode.has(edge.b)) byNode.set(edge.b, []);
      byNode.get(edge.b).push(edge);
    }
    for (const [, edges] of byNode) {
      if (edges.length <= maxPerNode) continue;
      edges.sort((x, y) => hebbianRank(y) - hebbianRank(x));
      for (const e of edges.slice(maxPerNode)) {
        if (!dryRun) mem._removeEdge(e);
        hebbianPruned++;
      }
    }
  }

  return { archived, edgesDecayed, edgesRemoved, hebbianPruned, scanned, dryRun };
}

// ---------------------------------------------------------------------------
// L3 摘要（确定性模板，不用 LLM）
// ---------------------------------------------------------------------------

/** 收集画像摘要素材：名字 / 所在地 / 身份 / 偏好 / 最近在忙 */
function collectSummary(mem) {
  const profiles = [];
  const facts = [];
  for (const n of mem.nodes.values()) {
    if (n.deleted || n.archived) continue;
    if (n.kind === 'profile') profiles.push(n);
    else if (n.kind === 'fact') facts.push(n);
  }
  if (!profiles.length && !facts.length) return null;
  const byImp = (a, b) => b.importance - a.importance || b.ts - a.ts;
  profiles.sort(byImp);
  facts.sort(byImp);

  let name = '';
  let identity = '';
  let location = '';
  const sources = [];

  for (const p of profiles) {
    if (!name) {
      const m = /名字是(.{1,16})/.exec(p.text);
      if (m) {
        name = trimPunct(m[1]);
        sources.push(p.id);
      }
    }
    if (!name) {
      const m = /希望被叫做(.{1,16})/.exec(p.text);
      if (m) {
        name = trimPunct(m[1]);
        sources.push(p.id);
      }
    }
    if (!identity) {
      const m = /身份是(.{1,16})/.exec(p.text);
      if (m) {
        identity = trimPunct(m[1]);
        sources.push(p.id);
      }
    }
    if (!location) {
      const m = /(?:住在|城市是|家在|来自)(.{2,14})/.exec(p.text);
      if (m) {
        location = trimPunct(m[1]);
        sources.push(p.id);
      }
    }
    if (name && location && identity) break;
  }

  // 偏好：带「偏好」标签的 fact 优先，其次看文面
  const prefs = [];
  for (const f of facts) {
    if (prefs.length >= 3) break;
    const tagged = Array.isArray(f.tags) && f.tags.includes('偏好');
    const looksPref = /^用户(喜欢|不喜欢|讨厌|习惯|偏好|爱|通常|平时)/.test(f.text);
    if (!tagged && !looksPref) continue;
    const t = trimPunct(f.text.replace(/^用户/, '你'));
    if (t && !prefs.includes(t)) prefs.push(truncateChars(t, 24));
    sources.push(f.id);
  }

  // 最近在忙：项目类 fact
  let project = '';
  for (const f of facts) {
    const tagged = Array.isArray(f.tags) && f.tags.includes('项目');
    const looksProject = /^用户(在做|在搞|在写|在开发|负责|用的是|用)/.test(f.text);
    if (!tagged && !looksProject) continue;
    const t = trimPunct(f.text.replace(/^用户在做|^用户在搞|^用户在写|^用户在开发/, ''));
    if (t) {
      project = truncateChars(t, 40);
      sources.push(f.id);
      break;
    }
  }

  const parts = [];
  if (name) parts.push(`你叫${name}`);
  if (location) parts.push(`你在${location}`);
  if (identity) parts.push(`你是${identity}`);
  if (prefs.length) parts.push(prefs.join('；'));
  if (project) parts.push(`最近在忙${project}`);
  if (!parts.length) return null;

  return {
    text: truncateChars(parts.join('；') + '。', 240),
    sources: Array.from(new Set(sources)),
  };
}

/** 找到已有的 L3 画像摘要节点 */
function findSummaryNode(mem) {
  for (const n of mem.nodes.values()) {
    if (n.kind === SUMMARY_KIND && n.meta && n.meta[SUMMARY_META_KEY]) return n;
  }
  return null;
}

/**
 * 刷新 L3 画像摘要节点（没有就创建，有就原地重写）。
 * 返回 {id, updated, created} 或 null（没有任何画像/事实素材时）。
 *
 * @param {any} mem
 * @param {{now?:number}} [opts]
 */
function refreshSummary(mem, opts = {}) {
  const now = num(opts.now, Date.now());
  const built = collectSummary(mem);
  if (!built) return null;
  const existing = findSummaryNode(mem);
  if (existing) {
    const changed = existing.text !== built.text;
    // 内容没变：不重写、不追加、不刷 ts（修复重复写入，2026-11-24）
    if (!changed) return { id: existing.id, updated: false, created: false, didChange: false };
    mem._rewriteNode(existing, {
      text: built.text,
      ts: now,
      importance: Math.max(num(existing.importance, 0), 0.95),
      meta: { ...(existing.meta || {}), [SUMMARY_META_KEY]: true, sources: built.sources, updatedAt: now },
    });
    return { id: existing.id, updated: true, created: false, didChange: true };
  }
  const node = mem._buildRecord({
    text: built.text,
    kind: SUMMARY_KIND,
    layer: LAYER.SUMMARY,
    tags: ['画像', '摘要'],
    importance: 0.95,
    source: 'consolidate',
    ts: now,
    meta: { [SUMMARY_META_KEY]: true, sources: built.sources },
  });
  node._tf = mem._tfFor(node);
  mem._insertNode(node);
  return { id: node.id, updated: true, created: true, didChange: true };
}

module.exports = {
  DAY_MS,
  LAYER,
  EDGE_KIND,
  SUMMARY_KIND,
  // 状态 / 公式
  stabilityOf,
  lastAccessAt,
  ageDays,
  retention,
  layerOf,
  isValidEdgeKind,
  touchNode,
  applyHebbian,
  pruneHebbianFor,
  forgetPass,
  // L3
  collectSummary,
  findSummaryNode,
  refreshSummary,
  // 工具（store.js 复用）
  num,
  clamp,
  clamp01,
  round,
  charLen,
  truncateChars,
  trimPunct,
};
