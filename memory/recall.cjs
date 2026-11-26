'use strict';

/**
 * 记忆星云 Lite — 四臂召回（lexical / activation / graph / profile）
 *
 * 设计对齐 MEMORY-NEBULA-SPEC.md §3 与参考实现 brain_engine.py：
 *
 *   ① lexical    ：query token 倒排并集 → 现有 bigram TF-IDF 余弦，取 top 40；
 *   ② activation ：A(v) = importance · R(v)，R = exp(-Δt/S)，取 top 12；
 *   ③ graph      ：词法臂前 6 个种子做 2 跳扩散，
 *                   A(v) = MAX ∏(w^α · γ^hop) · seed（α=1.0、γ=0.55），取 top 24；
 *   ④ profile    ：kind='profile' 或 layer='summary' 里 importance 最高的 3 条恒定入选。
 *
 * 融合：final = 0.55·lexNorm + 0.30·actNorm + 0.15·recencyR。
 * 去冗余：token 重叠 MMR（λ=0.7，相似度 > 0.85 的后选者降权）。
 *
 * 本模块只做「算」，不写盘、不改状态；touch / trace / 配额由 store.js 与
 * fragments.js 负责，保证四臂可以单独测、单独调参。
 */

const tx = require('./tokenize.cjs');
const dyn = require('./dynamics.cjs');

/** 三因子融合权重（SPEC §3；改名时同步 trace.weights） */
const RECALL_WEIGHTS = Object.freeze({ lexical: 0.55, activation: 0.3, recency: 0.15 });

const PARAMS = Object.freeze({
  lexTop: 40, // 词法臂候选上限
  actTop: 12, // 激活臂候选上限
  // 图扩散种子数（= 星云里点亮的「种子」数）。
  // 对齐旧版 dsh-brain-nebula 的 seedLimit=18（旧版从召回结果前 18 条取种子）；
  // 整合版这里取词法臂前 N 条作为扩散起点，6 会让种子明显偏少、星云偏暗。
  graphSeeds: 18,
  // 图扩散候选上限。旧版配额是 1跳=max(24,种子×3)、2跳=max(12,种子×2)，
  // 种子 18 时合计约 18+54+36=108；这里给到 120 才能让 1/2 跳铺得开，
  // 太小（原 24）会让 18 个种子几乎吃满名额，1/2 跳各只剩 3~4 个、整张星云偏暗。
  graphTop: 120,
  // 单节点扇出上限（超级节点防御）。度数超过它的节点在扩散时只取权重最高的 N 条边。
  // 实测：5000 度枢纽 2 跳 p50=9ms（对照组 0.54ms），可接受但无上限会随度数线性恶化；
  // 200 这个值保证「正常节点完全不受影响」，只截断病态枢纽。
  maxDegree: 200,
  profileTop: 3, // 画像臂恒定入选数
  hops: 2, // 扩散跳数（不要 3 跳：语义会漂）
  alpha: 1.0, // 边权指数
  gamma: 0.55, // 每跳衰减
  mmrLambda: 0.7, // MMR 相关性权重
  mmrThreshold: 0.85, // 超过这个 token 重叠算「冗余」
  minEdgeWeight: 0.001,
});

const { num, clamp, clamp01, round, layerOf } = dyn;

/**
 * 判断节点是否参与本轮候选。
 * archived 默认出池（includeArchived=true 才召回）；dormant 沿用 v1 语义。
 */
function eligible(node, opts) {
  if (!node || node.deleted) return false;
  if (node.archived && !opts.includeArchived) return false;
  if (node.dormant && !opts.includeDormant && !opts.includeArchived) return false;
  return true;
}

/**
 * 2 跳扩散：A(v) = MAX over paths ∏(w^α · γ^hop) · seed。
 * 用 MAX 而不是 SUM，避免 hub 节点霸屏（设计草案的结论）。
 *
 * @param {any} mem
 * @param {Map<string, number>} seeds id → seed 分数（0..1）
 * @param {{hops?:number, alpha?:number, gamma?:number, minEdgeWeight?:number,
 *          includeArchived?:boolean, includeDormant?:boolean}} [opts]
 * @returns {Map<string, {act:number, hop:number, via:string, seed:string}>}
 */
function spread(mem, seeds, opts = {}) {
  const hops = clamp(Math.floor(num(opts.hops, PARAMS.hops)), 1, 3);
  const alpha = num(opts.alpha, PARAMS.alpha);
  const gamma = num(opts.gamma, PARAMS.gamma);
  const minW = num(opts.minEdgeWeight, PARAMS.minEdgeWeight);
  // 单节点扇出上限（超级节点防御）；0 = 不限制
  const maxDeg = clamp(Math.floor(num(opts.maxDegree, PARAMS.maxDegree)), 0, 100000);
  const stats = opts.stats || null;
  if (stats && stats.truncatedHubs == null) stats.truncatedHubs = 0;
  /** @type {Map<string, {act:number, hop:number, via:string, seed:string}>} */
  const out = new Map();
  /** @type {Map<string, {act:number, via:string, seed:string}>} */
  let frontier = new Map();

  for (const [id, score] of seeds) {
    const node = mem.nodes.get(id);
    if (!node) continue;
    const s = clamp01(score);
    if (!(s > 0)) continue;
    out.set(id, { act: s, hop: 0, via: id, seed: id });
    frontier.set(id, { act: s, via: id, seed: id });
  }

  for (let hop = 1; hop <= hops; hop++) {
    if (!frontier.size) break;
    /** @type {Map<string, {act:number, via:string, seed:string}>} */
    const next = new Map();
    for (const [fromId, info] of frontier) {
      const adj = mem.adj.get(fromId);
      if (!adj) continue;
      // 超级节点防御：度数超限时只取权重最高的 maxDeg 条边。
      // 实测 5000 度枢纽 2 跳 p50=9ms 尚可接受，但度数无上限时
      // 每次遍历要全扫邻接表，且并发多查询会叠加放大。这里封顶换确定性。
      let edges = adj;
      if (maxDeg > 0 && adj.size > maxDeg) {
        edges = new Map(
          Array.from(adj.entries())
            .sort((a, b) => num(b[1], 0) - num(a[1], 0))
            .slice(0, maxDeg)
        );
        if (stats) stats.truncatedHubs++;
      }
      for (const [toId, wRaw] of edges) {
        const w = num(wRaw, 0);
        if (!(w > 0) || w < minW) continue;
        const node = mem.nodes.get(toId);
        if (!eligible(node, opts)) continue;
        const cand = info.act * Math.pow(w, alpha) * Math.pow(gamma, hop);
        if (!(cand > 0)) continue;
        const prev = next.get(toId);
        if (!prev || cand > prev.act) next.set(toId, { act: cand, via: fromId, seed: info.seed });
      }
    }
    for (const [id, info] of next) {
      const prev = out.get(id);
      if (!prev || info.act > prev.act) out.set(id, { act: info.act, hop, via: info.via, seed: info.seed });
    }
    frontier = next;
  }
  return out;
}

/** 候选对象工厂 */
function blankEntry(node) {
  return {
    id: node.id,
    node,
    lex: 0,
    activationRaw: 0,
    graphRaw: 0,
    actRaw: 0,
    hop: 0,
    via: null,
    seed: null,
    arms: { lexical: false, activation: false, graph: false, profile: false },
    lexNorm: 0,
    actNorm: 0,
    recency: 0,
    base: 0,
    tset: null,
  };
}

/** 给候选补上 token 集合（MMR 用），懒计算 */
function ensureTset(entry) {
  if (!entry.tset) entry.tset = tx.tokenSet(entry.node.text);
  return entry.tset;
}

/**
 * 跑一次四臂召回（纯计算）。
 *
 * @param {any} mem NebulaMemory（需要 nodes / postings / adj / edgeMap / _queryVector / _tfidfCosine）
 * @param {string} query
 * @param {Object} [options]
 * @returns {{
 *   query:string, ts:number, latencyMs:number, tokensUsed:number,
 *   seeds:Array<{id:string,score:number}>,
 *   activated:Array<{id:string,act:number,hop:number,arms:string}>,
 *   picked:Array<any>, candidates:number, dropped:number, penalized:number,
 *   arms:{lexical:number,activation:number,graph:number,profile:number},
 *   weights:Object, byId:Map<string,any>, params:Object
 * }}
 */
function runRecall(mem, query, options = {}) {
  const t0 = Date.now();
  const now = num(options.now, Date.now());
  const q = query == null ? '' : String(query);
  const topK = clamp(Math.floor(num(options.topK, 8)), 1, 30);
  const opts = {
    includeArchived: options.includeArchived === true,
    includeDormant: options.includeDormant === true,
    hops: options.hops,
    alpha: options.alpha,
    gamma: options.gamma,
  };
  const lexTopN = clamp(Math.floor(num(options.lexTop, PARAMS.lexTop)), 1, 200);
  const actTopN = clamp(Math.floor(num(options.actTop, PARAMS.actTop)), 1, 100);
  const graphTopN = clamp(Math.floor(num(options.graphTop, PARAMS.graphTop)), 1, 200);
  const graphSeedN = clamp(Math.floor(num(options.graphSeeds, PARAMS.graphSeeds)), 1, 20);
  const profileTopN = clamp(Math.floor(num(options.profileTop, PARAMS.profileTop)), 0, 10);
  const lambda = clamp(num(options.mmrLambda, PARAMS.mmrLambda), 0, 1);
  const mmrThreshold = clamp(num(options.mmrThreshold, PARAMS.mmrThreshold), 0, 1);

  /** @type {Map<string, any>} */
  const byId = new Map();
  const ensure = (node) => {
    let e = byId.get(node.id);
    if (!e) {
      e = blankEntry(node);
      byId.set(node.id, e);
    }
    return e;
  };

  // ---- ① lexical ---------------------------------------------------------
  const qv = mem._queryVector(q);
  const tokensUsed = qv && qv.w ? qv.w.size : 0;
  /** @type {Array<{id:string, lex:number}>} */
  let lexPool = [];
  if (tokensUsed) {
    const ids = new Set();
    for (const token of qv.w.keys()) {
      const set = mem.postings.get(token);
      if (!set) continue;
      for (const id of set) ids.add(id);
    }
    for (const id of ids) {
      const node = mem.nodes.get(id);
      if (!eligible(node, opts)) continue;
      const tf = node._tf || mem._tfFor(node);
      const lex = mem._tfidfCosine(tf, qv);
      if (lex > 0) lexPool.push({ id, lex });
    }
  }
  lexPool.sort((a, b) => b.lex - a.lex || a.id.localeCompare(b.id));
  const lexTop = lexPool.slice(0, lexTopN);
  for (const item of lexTop) {
    const e = ensure(mem.nodes.get(item.id));
    e.lex = Math.max(e.lex, item.lex);
    e.arms.lexical = true;
  }
  const maxLex = lexTop.length ? lexTop[0].lex : 0;

  // ---- ② activation ------------------------------------------------------
  /** @type {Array<{id:string, act:number}>} */
  const actPool = [];
  for (const node of mem.nodes.values()) {
    if (!eligible(node, opts)) continue;
    const act = num(node.importance, 0.5) * dyn.retention(node, now);
    if (act > 0) actPool.push({ id: node.id, act });
  }
  actPool.sort((a, b) => b.act - a.act || a.id.localeCompare(b.id));
  const actTop = actPool.slice(0, actTopN);
  for (const item of actTop) {
    const e = ensure(mem.nodes.get(item.id));
    e.activationRaw = Math.max(e.activationRaw, item.act);
    e.arms.activation = true;
  }

  // ---- ③ graph（词法臂前 N 个种子，2 跳扩散）------------------------------
  const seedMap = new Map();
  const seeds = [];
  for (const item of lexTop.slice(0, graphSeedN)) {
    const score = maxLex > 0 ? item.lex / maxLex : 0;
    if (!(score > 0)) continue;
    seedMap.set(item.id, score);
    seeds.push({ id: item.id, score: round(score, 4) });
  }
  /** @type {Array<{id:string, act:number, hop:number, via:string, seed:string}>} */
  const graphPool = [];
  if (seedMap.size) {
    const spreadRes = spread(mem, seedMap, opts);
    for (const [id, info] of spreadRes) {
      if (info.hop <= 0) continue;
      graphPool.push({ id, act: info.act, hop: info.hop, via: info.via, seed: info.seed });
    }
    graphPool.sort((a, b) => b.act - a.act || a.hop - b.hop || a.id.localeCompare(b.id));
    graphPool.length = Math.min(graphPool.length, graphTopN);
    for (const item of graphPool) {
      const node = mem.nodes.get(item.id);
      if (!node) continue;
      const e = ensure(node);
      e.graphRaw = Math.max(e.graphRaw, item.act);
      e.arms.graph = true;
      if (!(e.hop > 0)) {
        e.hop = item.hop;
        e.via = item.via;
        e.seed = item.seed;
      }
    }
  }

  // ---- ④ profile（恒定入选，直接置顶）-------------------------------------
  const profilePool = [];
  if (profileTopN > 0) {
    for (const node of mem.nodes.values()) {
      if (!eligible(node, opts)) continue;
      if (node.kind === 'profile' || layerOf(node.kind, node.layer) === dyn.LAYER.SUMMARY) profilePool.push(node);
    }
    profilePool.sort((a, b) => b.importance - a.importance || b.ts - a.ts);
    profilePool.length = Math.min(profilePool.length, profileTopN);
    for (const node of profilePool) {
      const e = ensure(node);
      e.arms.profile = true;
    }
  }

  // ---- 融合 ---------------------------------------------------------------
  const entries = Array.from(byId.values());
  let maxAct = 0;
  for (const e of entries) {
    e.actRaw = Math.max(e.activationRaw, e.graphRaw);
    if (e.actRaw > maxAct) maxAct = e.actRaw;
  }
  for (const e of entries) {
    e.lexNorm = maxLex > 0 ? clamp01(e.lex / maxLex) : 0;
    e.actNorm = maxAct > 0 ? clamp01(e.actRaw / maxAct) : 0;
    e.recency = dyn.retention(e.node, now);
    e.base =
      RECALL_WEIGHTS.lexical * e.lexNorm +
      RECALL_WEIGHTS.activation * e.actNorm +
      RECALL_WEIGHTS.recency * e.recency;
  }

  // ---- 去冗余：画像置顶 + MMR --------------------------------------------
  const pool = entries.slice().sort((a, b) => b.base - a.base || a.id.localeCompare(b.id));
  /** @type {any[]} */
  const picked = [];
  const pinned = pool.filter((e) => e.arms.profile).slice(0, Math.min(profileTopN, topK));
  for (const e of pinned) picked.push(e);
  const rest = pool.filter((e) => !pinned.includes(e));

  let penalized = 0;
  while (picked.length < topK && rest.length) {
    let bestIdx = -1;
    let bestVal = -Infinity;
    let bestSim = 0;
    for (let i = 0; i < rest.length; i++) {
      const e = rest[i];
      const set = ensureTset(e);
      let maxSim = 0;
      for (const p of picked) {
        const sim = tx.jaccard(set, ensureTset(p));
        if (sim > maxSim) maxSim = sim;
      }
      const val = lambda * e.base + (1 - lambda) * (1 - maxSim);
      if (val > bestVal) {
        bestVal = val;
        bestIdx = i;
        bestSim = maxSim;
      }
    }
    if (bestIdx < 0) break;
    if (bestSim > mmrThreshold) penalized++;
    picked.push(rest.splice(bestIdx, 1)[0]);
  }

  // ---- 臂归属 / 解释文案 --------------------------------------------------
  const reasons = { lexical: '直接命中', graph: '联想', profile: '画像', activation: '最近' };
  for (const e of picked) {
    let arm = 'activation';
    if (e.arms.profile) arm = 'profile';
    else if (e.arms.graph && e.hop > 0) arm = 'graph';
    else if (e.arms.lexical) arm = 'lexical';
    e.arm = arm;
    e.why = reasons[arm];
    e.score = round(e.base, 6);
    e.actNorm = round(e.actNorm, 4);
    e.lexNorm = round(e.lexNorm, 4);
    e.recency = round(e.recency, 4);
  }

  // ---- trace 用：激活列表（按激活值排，最多 24 条）-------------------------
  /** @type {Map<string, any>} */
  const actMap = new Map();
  const armsTag = (e) => `${e.arms.lexical ? 'l' : ''}${e.arms.activation ? 'a' : ''}${e.arms.graph ? 'g' : ''}${e.arms.profile ? 'p' : ''}`;
  for (const item of actTop) {
    const e = byId.get(item.id);
    if (!e) continue;
    actMap.set(item.id, { id: item.id, act: e.actRaw, hop: 0, arms: armsTag(e) });
  }
  for (const item of graphPool) {
    const e = byId.get(item.id);
    if (!e) continue;
    const prev = actMap.get(item.id);
    const rec = { id: item.id, act: round(e.actRaw, 4), hop: item.hop, arms: armsTag(e) };
    if (!prev || rec.act > prev.act) actMap.set(item.id, rec);
  }
  const activated = Array.from(actMap.values())
    .sort((a, b) => b.act - a.act || a.id.localeCompare(b.id))
    .slice(0, 24)
    .map((r) => ({ id: r.id, act: round(r.act, 4), hop: r.hop, arms: r.arms }));

  return {
    query: q,
    ts: now,
    latencyMs: Date.now() - t0,
    tokensUsed,
    seeds,
    activated,
    picked,
    candidates: pool.length,
    dropped: Math.max(0, pool.length - picked.length),
    penalized,
    arms: {
      lexical: lexTop.length,
      activation: actTop.length,
      graph: graphPool.length,
      profile: profilePool.length,
    },
    weights: RECALL_WEIGHTS,
    byId,
    params: { lexTopN, actTopN, graphTopN, graphSeedN, profileTopN, lambda, mmrThreshold, topK },
  };
}

module.exports = {
  RECALL_WEIGHTS,
  PARAMS,
  runRecall,
  spread,
  eligible,
};
