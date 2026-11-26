'use strict';

/**
 * 记忆星云 Lite — 存储 + 检索 + 巩固（NebulaMemory）
 *
 * 契约见 ARCHITECTURE.md §6.2。设计要点：
 *
 *  1. 存储全部是「追加写 JSONL + 快照」的纯文件方案，零外部依赖、单目录可迁移：
 *       nodes.jsonl  每行一个节点（同一 id 后写覆盖先写，天然支持更新与 tombstone）
 *       edges.jsonl  每行一条边（a/b/w，无向，a<b 归一化）
 *       index.json   倒排索引快照 + 版本（启动时仍从 jsonl 重建，保证永远一致）
 *     启动时把 jsonl 全量读进内存（<10 万节点量级完全够用），写操作同步原子落盘。
 *
 *  2. 检索打分（可在构造时用 weights 调整）：
 *       score = tfidf^w.tfidf × exp(-w.decay·age/半衰期) × (0.5 + w.importance·importance)
 *               × (1 + w.graph·min(cap, 邻居权重和/2)) × (dormant ? 0.55 : 1)
 *     - tfidf：中文 bigram + ASCII 词的 TF-IDF 余弦（见 tokenize.js），idf 用 BM25 式平滑；
 *     - 时间衰减：age = now - lastAccessAt（没访问过就用 ts），半衰期默认 30 天；
 *     - importance：0..1，显式记忆最高；
 *     - 图邻居加成：本轮回召候选里，与它相连的边的权重和（星云式「一起被想起」）。
 *
 *  3. 隔离：目录里出现 `.dsh` 这一段就直接拒绝（见 assertSafeDir），
 *     绝不写 DSH 自己的 Hindsight / Postgres 记忆。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');

const { MEM_KIND } = require('../shared/constants.cjs');
const tx = require('./tokenize.cjs');
const extract = require('./extract.cjs');
const dynamics = require('./dynamics.cjs');
const recallArms = require('./recall.cjs');
const fragmentsView = require('./fragments.cjs');

const { LAYER, EDGE_KIND, SUMMARY_KIND } = dynamics;

// ---------------------------------------------------------------------------
// 常量与默认参数
// ---------------------------------------------------------------------------

const APP = 'dsh-companion-memory';
const INDEX_VERSION = 2; // v2：节点多了 layer/stability/archived/act，边多了 kind/lastFired/fireCount
/** 合法 kind：MEM_KIND 四个 + L3 摘要（constants 尚未收录 summary，这里本地兜底） */
const KIND_SET = new Set([...Object.values(MEM_KIND), SUMMARY_KIND]);
const DAY_MS = 86400000;
const MAX_TEXT = 2000; // 单条记忆正文上限（字符）
const MAX_TAGS = 16;

/** 全部可调的打分 / 行为参数（构造时用 options 覆盖，或直接传同名字段） */
const DEFAULTS = {
  halfLifeDays: 30, // 时间衰减 e-folding 半衰期（天）
  decayHalfLifeDays: 90, // consolidate 里 importance 的衰减半衰期（天）
  dormantDays: 60, // 超过这么多天没访问的 episode 标记 dormant（不删除）
  dormantPenalty: 0.55, // dormant 节点在检索里的乘子
  dedupeThreshold: 0.92, // remember 去重阈值（同 kind、tf-idf 余弦）
  consolidateThreshold: 0.85, // episode 聚合阈值
  consolidateMinCluster: 2,
  consolidateMaxCluster: 12,
  consolidateMaxPairs: 20000, // 巩固时候选对上限（防 O(n²) 爆炸）
  accessBoost: 0.02, // 命中一次涨多少 importance
  importanceFloor: 0.02,
  graphBonusCap: 0.6,
  graphBonusScale: 0.5, // 邻居权重和 × 该系数后进 min()
  maxContextChars: 800, // renderContext 上限（含标题）
  indexFlushEvery: 64, // 每 N 次写盘落一次 index.json 快照
  pendingFlushAt: 48, // 内存里攒多少次访问更新后批量落盘
  compactionRatio: 2.5, // jsonl 行数 > 存活数×该比例 时在 close 时压缩
  minScore: 0.01, // recall 最低分（过滤纯噪音命中）

  // —— v2 记忆星云：召回片段 / trace / 动力学 ——
  recallTopK: 8, // recallFragments 默认返回片段数
  budgetChars: 1400, // 片段文本总字数上限（含标题）
  mmrLambda: 0.7, // MMR 相关性权重
  mmrThreshold: 0.85, // token 重叠超过它算冗余
  traceMax: 200, // trace.jsonl 保留最近多少条（超过即裁剪，硬上限）
  hebbEta: 0.02, // 赫布学习率
  hebbMinProduct: 0.3, // 共激活乘积下限（低于它不连边）
  hebbNewWeight: 0.1, // 新建合成边的初始权重
  archiveRetention: 0.15, // R 低于它进入归档候选
  archiveMinDays: 90, // 且闲置超过这么多天
  synapseIdleDays: 60, // 合成边超过这么久没触发 → 衰减
  synapseDecay: 0.9, // 每次衰减乘子
  synapseMinWeight: 0.01, // 低于它直接删除
  hebbianMaxPerNode: 16, // 每节点赫布边数上限：超出按 保留分(w×log2(1+触发)) 剪最弱（0 = 关闭）；防热点节点边无限累积
  observeConsolidateEvery: 20, // observe() 每 N 轮触发一次巩固
  observeConsolidateDays: 1, // 或距上次巩固超过 A 天
  tickConsolidateDays: 1, // tick() 里距上次巩固超过 A 天才真正巩固
  summaryRefreshMs: 300000, // tick() 里多久刷一次 L3 画像摘要（默认 5 分钟；0 = 每次 tick 都算）
  autoCompactRatio: 2.5, // 追加行数 > 存活×该比例 → 自动调度压缩（0 = 关闭自动压缩）
  autoCompactDelayMs: 5000, // 跨过阈值后延迟这么多毫秒再压（防抖：写突发结束才动手）
};

/** 打分权重（1 = 原位；调大可放大该因子对排序的影响） */
const DEFAULT_WEIGHTS = { tfidf: 1, decay: 1, importance: 1, graph: 1 };

const KIND_LABEL = { episode: '对话', fact: '事实', profile: '画像', note: '记住' };
/** renderContext 里标签的优先级：越靠前越像「用户会关心的类别」 */
const LABEL_PRIORITY = ['偏好', '身份', '称呼', '项目', '运动', '技术栈', '技术方向', '饮品', '宠物', '工具', '记忆', '显式', '事实'];
const LABEL_ALIAS = { 记忆: '记住', 显式: '记住' };

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function clamp(n, lo, hi) {
  return n < lo ? lo : n > hi ? hi : n;
}

function clamp01(n) {
  return clamp(Number.isFinite(n) ? n : 0, 0, 1);
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
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

/**
 * 长文本切块：超过 MAX_TEXT 的正文按语义边界切成多段，而不是静默截断。
 *
 * 背景（2026-11-23 实测）：原实现对 >2000 字的输入直接 slice 截断，
 * 5 万字的文档会被无声丢弃 96%，用户以为记住了实际只剩开头。
 *
 * 切分优先级：段落（\n\n）→ 句子（。！？；\n）→ 字符硬切（兜底）。
 * 每块长度 <= MAX_TEXT，块间保留 context 关联标记，便于后续按 docId 聚合。
 *
 * @param {string} text 已 cleanText 的正文
 * @param {number} max 单块上限
 * @returns {string[]} 切块结果（1 块 = 无需切分）
 */
function splitText(text, max = MAX_TEXT) {
  const chars = Array.from(String(text == null ? '' : text));
  if (chars.length <= max) return [chars.join('')];

  const segments = [];   // { text, len }
  const push = (s) => {
    const t = s.trim();
    if (!t) return;
    segments.push({ text: t, len: Array.from(t).length });
  };

  // 1) 先按段落切
  const paras = chars.join('').split(/\n{2,}/);
  for (const p of paras) {
    if (Array.from(p).length <= max) { push(p); continue }
    // 2) 段落仍超长 → 按句子切
    const sentences = p.split(/(?<=[。！？；!?;\n])/);
    for (const s of sentences) {
      if (Array.from(s).length <= max) { push(s); continue }
      // 3) 单句仍超长（无标点长文）→ 字符硬切
      const arr = Array.from(s);
      for (let i = 0; i < arr.length; i += max) push(arr.slice(i, i + max).join(''));
    }
  }

  // 4) 贪心合并相邻片段，尽量填满每块。
  //    关键：严格按「合并后的实际长度」判断，绝不能因为放不下就丢弃片段——
  //    早期实现用 curLen + seg.len 估算漏算分隔符，导致每次换块丢一段（实测丢 10~19%）。
  const out = [];
  let cur = '';
  for (const seg of segments) {
    if (!cur) { cur = seg.text; continue }
    const joined = cur + seg.text
    if (Array.from(joined).length <= max) {
      cur = joined
    } else {
      out.push(cur)
      cur = seg.text
    }
  }
  if (cur) out.push(cur)

  // 保守校验：合并后总字数不应少于原文的 99%（空白归一造成的差异除外）
  const outChars = out.reduce((n, s) => n + Array.from(s).length, 0)
  const srcChars = Array.from(text).length
  if (!out.length || outChars < srcChars * 0.99) {
    // 兜底：退回纯字符硬切，保证绝对不丢
    const arr = Array.from(text)
    const hard = []
    for (let i = 0; i < arr.length; i += max) hard.push(arr.slice(i, i + max).join(''))
    return hard
  }
  return out;
}


/** 同步小睡（Windows 上 rename 撞杀软/句柄时会重试） */
function sleepMs(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* 极端环境不支持 SharedArrayBuffer 时退化成忙等（可忽略） */
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* spin */
    }
  }
}

/**
 * 展示用文本归一：NFC + 折叠空白 + 去首尾空白。
 * 刻意不用 NFKC —— 那会把中文全角标点（，。！）也拆成 ASCII，渲染给用户看会变形；
 * 匹配用的强归一化在 tokenize.normalizeText() 里做（NFKC + 小写）。
 */
function cleanText(text) {
  if (text == null) return '';
  let s = String(text);
  try {
    s = s.normalize('NFC');
  } catch {
    /* ignore */
  }
  return s.replace(/\s+/g, ' ').trim();
}

function normalizeTags(tags) {
  const out = [];
  if (!Array.isArray(tags)) return out;
  for (const t of tags) {
    const v = cleanText(t).slice(0, 40);
    if (!v) continue;
    if (!out.includes(v)) out.push(v);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

function sanitizeMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return {};
  let s;
  try {
    s = JSON.stringify(meta);
  } catch {
    return { _dropped: 'meta not serializable' };
  }
  if (s.length > 8000) return { _dropped: 'meta too large' };
  return JSON.parse(s);
}

function makeId() {
  return 'm' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

function edgeKey(a, b) {
  return a < b ? `${a}\u0001${b}` : `${b}\u0001${a}`;
}

/** 排序 & 去重字符串数组 */
function uniqStrings(list) {
  const out = [];
  for (const s of list || []) {
    const v = String(s == null ? '' : s);
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * 目录守卫：允许 DSH_HOME 下的专用记忆子目录（默认 memory-nebula-data），
 * 但拒绝磁盘根目录、用户主目录和 DSH_HOME 本身，避免把 JSONL 写到宽泛位置。
 * 更早版本曾拒绝一切包含 .dsh 的路径段，与插件当前的数据布局相冲突。
 * @param {string} dir
 * @returns {string} 绝对路径
 */
function assertSafeDir(dir) {
  const abs = path.resolve(String(dir || ''));
  const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  if (norm(abs) === norm(path.parse(abs).root)) {
    throw new Error(`memory: refusing to use a filesystem root (got: ${abs})`);
  }
  const homeDsh = path.join(os.homedir(), '.dsh');
  const forbidden = [os.homedir(), homeDsh, process.env.DSH_HOME].filter(Boolean);
  if (forbidden.some((parent) => norm(abs) === norm(parent))) {
    throw new Error(`memory: refusing to use a broad home directory (got: ${abs})`);
  }
  return abs;
}

// ---------------------------------------------------------------------------
// 文件原语
// ---------------------------------------------------------------------------

/**
 * 读 JSONL：每行 JSON → onLine(obj)。坏行只记数不抛错（容忍崩溃留下的半行）。
 * @param {string} file
 * @param {(obj: any) => void} onLine
 * @returns {{lines: number, bad: number, bytes: number}}
 */
function readJsonl(file, onLine) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { lines: 0, bad: 0, bytes: 0 };
    throw err;
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  if (!text) return { lines: 0, bad: 0, bytes };
  let lines = 0;
  let bad = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    lines++;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      bad++;
      continue;
    }
    try {
      onLine(obj);
    } catch {
      bad++;
    }
  }
  return { lines, bad, bytes };
}

/** 数一个文件的非空行（trace.jsonl 用；不存在算 0） */
function countLines(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }
  if (!text) return 0;
  let n = 0;
  for (const raw of text.split('\n')) if (raw.trim()) n++;
  return n;
}

/** 原子写：写 tmp → fsync → rename 覆盖；Windows 句柄占用时短暂重试 */
function atomicWrite(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, data, 'utf8');
    try {
      fs.fsyncSync(fd);
    } catch {
      /* 某些文件系统不支持 fsync，忽略 */
    }
  } finally {
    fs.closeSync(fd);
  }
  let lastErr = null;
  for (let i = 0; i < 5; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      lastErr = err;
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) break;
      sleepMs(15 + i * 25);
    }
  }
  try {
    fs.rmSync(tmp, { force: true });
  } catch {
    /* ignore */
  }
  throw lastErr;
}

/** 追加一行（append 只写一行，崩溃最多丢最后一行，读入时会当坏行跳过） */
function appendLine(file, obj) {
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeSync(fd, JSON.stringify(obj) + '\n', null, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/** 人类可读的时间差（renderContext 用） */
function formatAge(ms) {
  const sec = Math.max(0, ms) / 1000;
  if (sec < 60) return '刚刚';
  const min = sec / 60;
  if (min < 60) return `${Math.floor(min)}分钟前`;
  const hr = min / 60;
  if (hr < 24) return `${Math.floor(hr)}小时前`;
  const day = hr / 24;
  if (day < 30) return `${Math.floor(day)}天前`;
  const mon = day / 30;
  if (mon < 12) return `${Math.floor(mon)}个月前`;
  return `${Math.floor(mon / 12)}年前`;
}

// ---------------------------------------------------------------------------
// NebulaMemory
// ---------------------------------------------------------------------------

class NebulaMemory {
  /**
   * @param {{dir: string, log?: Function|Object, options?: Object, weights?: Object}} options
   */
  constructor(options = {}) {
    if (!options || !options.dir) throw new TypeError('memory: new NebulaMemory({ dir }) 缺少 dir');
    this.dir = assertSafeDir(options.dir);
    this.fileNodes = path.join(this.dir, 'nodes.jsonl');
    this.fileEdges = path.join(this.dir, 'edges.jsonl');
    this.fileIndex = path.join(this.dir, 'index.json');
    this.fileTrace = path.join(this.dir, 'trace.jsonl');

    this.opts = { ...DEFAULTS, ...(options.options || {}) };
    // 允许在顶层直接覆盖常用参数，写起来更顺手
    for (const k of Object.keys(DEFAULTS)) {
      if (options[k] != null) this.opts[k] = options[k];
    }
    this.weights = { ...DEFAULT_WEIGHTS, ...(options.weights || {}) };
    this._logger = options.log || null;

    /** @type {Map<string, any>} 存活节点 */
    this.nodes = new Map();
    /** @type {Map<string, any>} 所有原始记录（含 tombstone），用于导出/统计 */
    this._raw = new Map();
    /** @type {Map<string, {a:string,b:string,w:number}>} */
    this.edgeMap = new Map();
    /** @type {Map<string, Map<string, number>>} 邻接表 */
    this.adj = new Map();
    /** @type {Map<string, Set<string>>} 倒排索引 */
    this.postings = new Map();
    /** @type {Map<string, number>} document frequency */
    this.df = new Map();

    this._idfCache = new Map();
    this._idfVersion = -1;
    this._dfVersion = 0;
    this.version = 0;

    this._nodeLines = 0;
    this._edgeLines = 0;
    this._badLines = 0;
    this._indexDirty = true;
    this._indexMeta = null;
    this._writesSinceIndex = 0;
    this._pending = new Set();
    this._ready = false;
    this._initPromise = null;
    this._closed = false;

    // —— v2：trace / 巩固节流 / 轮次计数 ——
    this._traceLines = 0;
    this._traceSeq = 0;
    this._lastConsolidateAt = 0;
    this._lastSummaryRefreshAt = 0; // L3 画像摘要上次刷新时刻（tick 节流用）
    this._lastTickAt = 0;
    this._observeTurns = 0;
    this._turnCounter = 0;
    /** 无向边 key 归一（dynamics.js 也通过 mem._edgeKey 使用） */
    this._edgeKey = edgeKey;
  }

  // -- 日志 -----------------------------------------------------------------

  _log(level, ...args) {
    const logger = this._logger;
    const msg = args
      .map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.message : JSON.stringify(a)))
      .join(' ');
    if (!logger) return;
    try {
      if (typeof logger === 'function') {
        logger(`[memory:${level}] ${msg}`);
      } else if (typeof logger[level] === 'function') {
        logger[level](msg);
      } else if (typeof logger.log === 'function') {
        logger.log(msg);
      }
    } catch {
      /* 日志失败不能影响主流程 */
    }
  }

  // -- 生命周期 -------------------------------------------------------------

  /** @returns {Promise<NebulaMemory>} */
  async init() {
    if (this._closed) throw new Error('memory: instance already closed');
    if (this._ready) return this;
    if (this._initPromise) return this._initPromise;
    this._initPromise = (async () => {
      fs.mkdirSync(this.dir, { recursive: true });
      // 三个文件保持始终存在，便于外部工具/备份直接扫目录
      for (const file of [this.fileNodes, this.fileEdges]) {
        if (!fs.existsSync(file)) fs.writeFileSync(file, '', 'utf8');
      }
      this._loadNodes();
      this._loadEdges();
      this._rebuildDerived();
      this._loadIndexSnapshotMeta();
      this._traceLines = countLines(this.fileTrace);
      if (this._indexMeta) {
        this._lastConsolidateAt = num(this._indexMeta.lastConsolidateAt, 0);
        this._lastTickAt = num(this._indexMeta.lastTickAt, 0);
        this._traceSeq = num(this._indexMeta.traceSeq, 0);
      }
      this._ready = true;
      if (this._indexDirty) this._writeIndexSnapshot();
      this._scheduleAutoCompact();   // 重启加载后若追加历史已膨胀，排一次自动压缩
      this._log(
        'info',
        `ready dir=${this.dir} nodes=${this.nodes.size} edges=${this.edgeMap.size} badLines=${this._badLines}`
      );
      return this;
    })();
    try {
      return await this._initPromise;
    } finally {
      this._initPromise = null;
    }
  }

  _assertReady() {
    if (this._closed) throw new Error('memory: 实例已关闭（close() 之后需要新建实例）');
    if (!this._ready) throw new Error('memory: 未初始化，请先 await init()');
  }

  /** 关闭：落 pending 更新 → 必要时压缩 → 落索引快照。可重复调用。 */
  async close() {
    if (!this._ready) return;
    if (this._autoCompactTimer) { clearTimeout(this._autoCompactTimer); this._autoCompactTimer = null; }
    this._flushPending();
    this._maybeCompact();
    if (this._traceLines > num(this.opts.traceMax, 200)) this._compactTrace();
    this._writeIndexSnapshot();
    this._log('info', `closed dir=${this.dir} nodes=${this.nodes.size} edges=${this.edgeMap.size}`);
    this._ready = false;
    this._closed = true;
  }

  /**
   * 手动压缩（实例保持可用）：落 pending → 强制重写 nodes/edges jsonl → 落索引快照。
   * 只序列化内存里的存活集，规模再大也是亚秒级；收益是磁盘文件和下一次冷启动。
   * @returns {Promise<{ok:boolean, durationMs:number, before:Object, after:Object, dir:string}>}
   */
  async compact() {
    this._assertReady();
    const t = Date.now();
    const sizeOf = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
    const before = {
      nodeLines: this._nodeLines,
      edgeLines: this._edgeLines,
      nodesMB: +(sizeOf(this.fileNodes) / 1048576).toFixed(1),
      edgesMB: +(sizeOf(this.fileEdges) / 1048576).toFixed(1),
      alive: { nodes: this.nodes.size, edges: this.edgeMap.size },
    };
    this._flushPending();
    this._compactNodesNow = true;
    this._maybeCompact();
    this._compactNodesNow = false;
    if (this._traceLines > num(this.opts.traceMax, 200)) this._compactTrace();
    this._writeIndexSnapshot();
    const after = {
      nodeLines: this._nodeLines,
      edgeLines: this._edgeLines,
      nodesMB: +(sizeOf(this.fileNodes) / 1048576).toFixed(1),
      edgesMB: +(sizeOf(this.fileEdges) / 1048576).toFixed(1),
      alive: { nodes: this.nodes.size, edges: this.edgeMap.size },
    };
    const out = { ok: true, durationMs: Date.now() - t, before, after, dir: this.dir };
    this._log('info', `compact: nodeLines ${before.nodeLines} -> ${after.nodeLines}, ${before.nodesMB}MB -> ${after.nodesMB}MB in ${out.durationMs}ms`);
    return out;
  }

  /**
   * 自动压缩调度：追加行数超过 存活×autoCompactRatio 时，延迟 autoCompactDelayMs 执行。
   * 压缩只重写存活集（亚秒级），不阻塞当前请求；阈值防抖保证一次写突发只压一次。
   */
  _scheduleAutoCompact() {
    if (this._autoCompactTimer || this._closed) return;
    const ratio = num(this.opts.autoCompactRatio, 2.5);
    if (ratio <= 0) return; // 0 = 关闭
    if (this._nodeLines <= Math.max(200, this.nodes.size * ratio)) return;
    this._autoCompactTimer = setTimeout(() => {
      this._autoCompactTimer = null;
      if (this._closed || !this._ready) return;
      try {
        this._flushPending();
        this._compactNodesNow = true;
        this._maybeCompact();
        this._compactNodesNow = false;
        if (this._traceLines > num(this.opts.traceMax, 200)) this._compactTrace();
        this._writeIndexSnapshot();
        this._log('info', `auto-compact done: nodeLines=${this._nodeLines} nodes=${this.nodes.size}`);
      } catch (e) {
        this._log('warn', `auto-compact failed: ${e.message}`);
      }
    }, Math.max(0, num(this.opts.autoCompactDelayMs, 5000)));
    this._autoCompactTimer.unref?.();
  }

  // -- 写入 -----------------------------------------------------------------

  /**
   * 记住一条。
   * @param {{text:string, kind?:string, tags?:string[], importance?:number, source?:string, meta?:Object, ts?:number}} input
   * @returns {Promise<{id:string, deduped:boolean, node:Object}>}
   */
  async remember(input = {}) {
    this._assertReady();
    // 超长文本自动切块（2026-11-23 修复静默截断：原实现直接 slice(0, 2000)）
    const raw = cleanText(input.text);
    const chunks = splitText(raw, MAX_TEXT);
    if (chunks.length > 1) {
      const docId = `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      this._log('info', `remember: 文本 ${Array.from(raw).length} 字超上限，自动切为 ${chunks.length} 块 (docId=${docId})`);
      const ids = [];
      for (let i = 0; i < chunks.length; i++) {
        const r = await this._rememberOne({
          ...input,
          text: chunks[i],
          _noDedupe: true,
          meta: { ...(input.meta || {}), docId, chunkIndex: i, chunkTotal: chunks.length },
        });
        ids.push(r.id);
        // 同文档相邻块连边，便于召回时整篇聚合
        if (i > 0) {
          try {
            this._addEdge(ids[i - 1], r.id, 1, { kind: EDGE_KIND.SEMANTIC, source: 'chunk' })
          } catch (e) {
            this._log('warn', `remember: 块间连边失败 (${e.message})`)
          }
        }
      }
      return { id: ids[0], ids, deduped: false, chunks: chunks.length, docId, node: this._publicNode(this.nodes.get(ids[0])) };
    }
    return this._rememberOne(input);
  }

  /** 单条写入（被 remember 调用；超长已在调用方切块）。 */
  async _rememberOne(input = {}) {
    const rec = this._buildRecord(input);
    rec._tf = this._tfFor(rec);

    // 同 kind 余弦 > 阈值 → 不新增，更新已有节点的时间与重要性。
    // 例外：长文档切块（input._noDedupe）必须整块独立保存 —— 同一篇文档的相邻块
    // 本就高度相似，若互相去重会把整篇压成一条，等于又丢了内容（2026-11-23 实测确认）。
    const dup = input._noDedupe ? null : this._findDuplicate(rec);
    if (dup) {
      const now = rec.ts;
      this._unindexNode(dup);
      dup.ts = now; // 重新确认 → 时间前移
      dup.lastAccessAt = Math.max(num(dup.lastAccessAt, dup.ts), now);
      dup.importance = clamp01(Math.max(dup.importance, rec.importance));
      dup.tags = normalizeTags([...dup.tags, ...rec.tags]);
      if (rec.source && rec.source !== 'unknown') dup.source = rec.source;
      if (rec.meta && Object.keys(rec.meta).length) dup.meta = { ...(dup.meta || {}), ...rec.meta };
      dup._tf = this._tfFor(dup);
      this._indexNode(dup);
      this._appendNode(dup);
      this.version++;
      this._dfVersion++;
      this._indexDirty = true;
      this._maybeFlushIndex();
      this._log('debug', `dedupe hit ${dup.id}`);
      return { id: dup.id, deduped: true, node: this._publicNode(dup) };
    }

    this.nodes.set(rec.id, rec);
    this._indexNode(rec);
    this._appendNode(rec);
    this.version++;
    this._dfVersion++;
    this._indexDirty = true;
    this._maybeFlushIndex();
    return { id: rec.id, deduped: false, node: this._publicNode(rec) };
  }

  /**
   * 连一条星云边（无向）。
   * @param {string} aId
   * @param {string} bId
   * @param {number} [weight]
   * @param {{kind?:string}} [meta] kind: semantic | hebbian | explicit（默认 semantic）
   */
  async link(aId, bId, weight = 1, meta = {}) {
    this._assertReady();
    const a = String(aId == null ? '' : aId);
    const b = String(bId == null ? '' : bId);
    if (!a || !b) throw new TypeError('memory: link(a, b) 需要两个 id');
    if (a === b) throw new Error('memory: link(a, b) 不允许自连');
    if (!this.nodes.has(a)) throw new Error(`memory: link 失败，节点不存在: ${a}`);
    if (!this.nodes.has(b)) throw new Error(`memory: link 失败，节点不存在: ${b}`);
    const edge = this._addEdge(a, b, weight, meta);
    this.version++;
    return { ok: true, a: edge.a, b: edge.b, weight: edge.w, kind: edge.kind };
  }

  /**
   * 软删除：写 tombstone，索引与图里摘掉，磁盘记录保留（close 时压缩才清理）。
   * @param {string} id
   */
  async forget(id) {
    this._assertReady();
    const key = String(id == null ? '' : id);
    const node = this.nodes.get(key);
    if (!node) return { ok: false, error: 'not_found', id: key };
    const now = Date.now();
    this._unindexNode(node);
    this.nodes.delete(key);
    this._removeEdgesOf(key);
    this._pending.delete(key);
    node.deleted = true;
    node.deletedAt = now;
    this._appendNode(node); // tombstone：同 id 后写覆盖先写
    this.version++;
    this._dfVersion++;
    this._indexDirty = true;
    this._maybeFlushIndex();
    this._log('info', `forget ${key}`);
    return { ok: true, id: key };
  }

  // -- 检索 -----------------------------------------------------------------

  /**
   * 召回。
   * @param {string} query
   * @param {{limit?:number, kind?:string, kinds?:string[], tag?:string, minScore?:number,
   *          includeDormant?:boolean, includeArchived?:boolean, trackAccess?:boolean, debug?:boolean}} [options]
   * @returns {Promise<Array<Object>>}
   */
  async recall(query, options = {}) {
    this._assertReady();
    const qv = this._queryVector(query);
    if (!qv.w.size) return [];

    const limit = clamp(Math.floor(num(options.limit, 6)), 1, 50);
    const kinds = options.kinds || (options.kind ? [options.kind] : null);
    const minScore = num(options.minScore, this.opts.minScore);
    const includeDormant = options.includeDormant === true;
    const includeArchived = options.includeArchived === true;

    // 候选集：所有 query token 的倒排并集
    const cand = new Set();
    for (const token of qv.w.keys()) {
      const ids = this.postings.get(token);
      if (!ids) continue;
      for (const id of ids) cand.add(id);
    }
    if (!cand.size) return [];

    const now = Date.now();
    const w = this.weights;
    const halfLife = Math.max(0.5, num(this.opts.halfLifeDays, 30));
    const scored = [];

    for (const id of cand) {
      const node = this.nodes.get(id);
      if (!node) continue;
      if (kinds && !kinds.includes(node.kind)) continue;
      if (options.tag && !node.tags.includes(options.tag)) continue;
      if (!includeArchived && node.archived) continue;
      if (!includeDormant && node.dormant) continue;

      const lexical = this._tfidfCosine(node._tf, qv);
      if (lexical <= 0) continue;

      const ageDays = Math.max(0, (now - num(node.lastAccessAt, node.ts)) / DAY_MS);
      // importance 满值（≥1.0）= 置顶/永久事实，decay 恒为 1，不受时间衰减（与 dynamics.retention 同口径）
      const decay = clamp01(node.importance) >= 1 ? 1 : Math.exp((-w.decay * ageDays) / halfLife);
      const impFactor = 0.5 + w.importance * clamp01(node.importance);
      const graphFactor = 1 + w.graph * Math.min(this.opts.graphBonusCap, this._neighborWeight(id, cand) * this.opts.graphBonusScale);
      const dormantFactor = node.dormant ? this.opts.dormantPenalty : 1;
      const lexicalPart = w.tfidf === 1 ? lexical : Math.pow(lexical, w.tfidf);
      const score = lexicalPart * decay * impFactor * graphFactor * dormantFactor;
      if (!(score >= minScore)) continue;

      /** @type {any} */
      const hit = {
        id: node.id,
        text: node.text,
        score: round(score, 4),
        kind: node.kind,
        tags: node.tags.slice(),
        ts: node.ts,
        importance: round(node.importance, 3),
        ageDays: round(ageDays, 1),
        dormant: !!node.dormant,
      };
      // 打分拆解只在 debug 时给出（默认返回保持契约的紧凑结构）
      if (options.debug) {
        hit.parts = {
          lexical: round(lexical, 4),
          decay: round(decay, 4),
          importance: round(impFactor, 4),
          graph: round(graphFactor, 4),
        };
      }
      scored.push(hit);
    }

    scored.sort((a, b) => b.score - a.score || b.ts - a.ts);
    const hits = scored.slice(0, limit);

    // 命中的记忆算一次「访问」：走 FSRS（稳定性增长、act 写回、清 dormant）
    if (options.trackAccess !== false && hits.length) {
      for (const hit of hits) {
        const node = this.nodes.get(hit.id);
        if (node) dynamics.touchNode(this, node, { now, act: clamp01(hit.score) });
      }
    }
    return hits;
  }

  /**
   * 巩固：相似 episode → fact 摘要；importance 随时间衰减；长期未访问的打 dormant。
   * @returns {Promise<Object>} 统计
   */
  async consolidate() {
    this._assertReady();
    const t0 = Date.now();
    const now = Date.now();
    const maxPairs = Math.max(100, Math.floor(num(this.opts.consolidateMaxPairs, 20000)));
    const threshold = num(this.opts.consolidateThreshold, 0.85);

    /** @type {any[]} */
    const episodes = [];
    for (const n of this.nodes.values()) if (n.kind === MEM_KIND.EPISODE) episodes.push(n);

    // 1) 候选对：只在共享 token 的 episode 之间比较（避免 O(n²) 全量两两比较）
    /** @type {Map<string, number>} */
    const pairShared = new Map();
    let pairOverflow = false;
    outer: for (const [token, ids] of this.postings) {
      if (ids.size < 2 || ids.size > 300) continue; // 极常见 token 没有区分度
      const list = [];
      for (const id of ids) {
        const n = this.nodes.get(id);
        if (n && n.kind === MEM_KIND.EPISODE) list.push(n);
      }
      if (list.length < 2) continue;
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const key = edgeKey(list[i].id, list[j].id);
          pairShared.set(key, (pairShared.get(key) || 0) + 1);
          if (pairShared.size >= maxPairs) {
            pairOverflow = true;
            this._log('warn', `consolidate: 候选对达到上限 ${maxPairs}，本轮只处理已收集部分`);
            break outer;
          }
        }
      }
    }

    // 2) 并查集聚簇
    const parent = new Map();
    for (const ep of episodes) parent.set(ep.id, ep.id);
    const find = (x) => {
      let root = x;
      while (parent.get(root) !== root) root = parent.get(root);
      let cur = x;
      while (parent.get(cur) !== cur) {
        const next = parent.get(cur);
        parent.set(cur, root);
        cur = next;
      }
      return root;
    };
    const union = (x, y) => {
      const rx = find(x);
      const ry = find(y);
      if (rx !== ry) parent.set(rx, ry);
    };

    let compared = 0;
    for (const [key, shared] of pairShared) {
      if (shared < 2) continue; // 只共享 1 个 bigram 太弱，不算相似
      const [a, b] = key.split('\u0001');
      const na = this.nodes.get(a);
      const nb = this.nodes.get(b);
      if (!na || !nb) continue;
      compared++;
      const sim = this._tfidfCosinePair(na._tf, nb._tf);
      if (sim >= threshold) union(a, b);
    }

    /** @type {Map<string, any[]>} */
    const groups = new Map();
    for (const ep of episodes) {
      const root = find(ep.id);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(ep);
    }

    // 3) 每个簇 → 一个 fact 摘要节点（代表句 + 最长公共子串，不用 LLM）
    let factsCreated = 0;
    let factsMerged = 0;
    let episodesConsolidated = 0;
    let edgesAdded = 0;
    const minCluster = Math.max(2, Math.floor(num(this.opts.consolidateMinCluster, 2)));
    const maxCluster = Math.max(2, Math.floor(num(this.opts.consolidateMaxCluster, 12)));

    for (const members of groups.values()) {
      if (members.length < minCluster) continue;
      const top = members
        .slice()
        .sort((x, y) => y.importance - x.importance || y.ts - x.ts)
        .slice(0, maxCluster);
      const draft = this._buildFactDraft(top, now);
      const dup = this._findDuplicate(draft);
      /** @type {any} */
      let fact;
      if (dup) {
        this._unindexNode(dup);
        dup.ts = now;
        dup.importance = clamp01(Math.max(dup.importance, draft.importance));
        dup.tags = normalizeTags([...dup.tags, ...draft.tags]);
        dup.meta = {
          ...(dup.meta || {}),
          from: uniqStrings([...(Array.isArray(dup.meta && dup.meta.from) ? dup.meta.from : []), ...draft.meta.from]),
          clusterSize: top.length,
          consolidatedAt: now,
        };
        dup._tf = this._tfFor(dup);
        this._indexNode(dup);
        this._appendNode(dup);
        fact = dup;
        factsMerged++;
      } else {
        fact = draft;
        this.nodes.set(fact.id, fact);
        this._indexNode(fact);
        this._appendNode(fact);
        factsCreated++;
      }
      this.version++;
      this._dfVersion++;

      for (const m of top) {
        const already = m.meta && m.meta.consolidatedInto;
        if (already === fact.id) continue;
        m.meta = { ...(m.meta || {}), consolidatedInto: fact.id, consolidatedAt: now };
        this._appendNode(m);
        this._writesSinceIndex++;
        const sim = Math.max(0.5, this._tfidfCosinePair(fact._tf, m._tf));
        if (!this.edgeMap.has(edgeKey(fact.id, m.id))) {
          this._addEdge(fact.id, m.id, round(sim, 3));
          edgesAdded++;
        }
        episodesConsolidated++;
      }
    }

    // 4) importance 时间衰减 + dormant 标记（只打标，不删除）
    let decayed = 0;
    let dormantMarked = 0;
    let dormantCleared = 0;
    const changed = new Set();
    const decayHalfLife = Math.max(1, num(this.opts.decayHalfLifeDays, 90));
    const dormantDays = Math.max(1, num(this.opts.dormantDays, 60));
    for (const n of this.nodes.values()) {
      const idleDays = Math.max(0, (now - num(n.lastAccessAt, n.ts)) / DAY_MS);
      // importance 满值（≥1.0）= 置顶/永久事实，跳过 importance 衰减（否则 pin 会被 consolidate 慢慢压下去）
      if (idleDays >= 0.5 && clamp01(n.importance) < 1) {
        const next = Math.max(this.opts.importanceFloor, n.importance * Math.exp(-idleDays / decayHalfLife));
        if (n.importance - next > 0.001) {
          n.importance = round(next, 4);
          changed.add(n.id);
          decayed++;
        }
      }
      if (n.kind === MEM_KIND.EPISODE) {
        const shouldDormant = idleDays >= dormantDays && n.importance < 0.5;
        if (shouldDormant && !n.dormant) {
          n.dormant = true;
          changed.add(n.id);
          dormantMarked++;
        } else if (!shouldDormant && n.dormant) {
          n.dormant = false;
          changed.add(n.id);
          dormantCleared++;
        }
      }
    }
    for (const id of changed) {
      const n = this.nodes.get(id);
      if (n) this._appendNode(n);
    }

    // 5) L3 画像摘要（确定性模板；没有任何画像/事实素材时返回 null）
    const summary = dynamics.refreshSummary(this, { now });
    this._lastSummaryRefreshAt = now;

    this._lastConsolidateAt = now;
    this._flushPending();
    this._maybeFlushIndex(true);
    this._indexDirty = true;
    this._writeIndexSnapshot();

    const result = {
      ok: true,
      scannedEpisodes: episodes.length,
      candidatePairs: pairShared.size,
      comparedPairs: compared,
      pairOverflow,
      clusters: [...groups.values()].filter((g) => g.length >= minCluster).length,
      episodeGroups: groups.size,
      factsCreated,
      factsMerged,
      episodesConsolidated,
      edgesAdded,
      decayed,
      dormantMarked,
      dormantCleared,
      durationMs: Date.now() - t0,
      // v2：L3 画像摘要
      summaryId: summary ? summary.id : null,
      summaryUpdated: !!(summary && summary.updated),
    };
    this._log('info', `consolidate ${JSON.stringify(result)}`);
    return result;
  }

  // -- 渲染 / 统计 ----------------------------------------------------------

  /**
   * 生成给大脑用的紧凑中文块（总长 <= maxContextChars，默认 800 字）。
   * @param {Array<Object>} hits recall 结果或任意含 text/kind/tags/ts 的节点数组
   * @param {{maxChars?:number, header?:string}} [options]
   * @returns {string}
   */
  renderContext(hits, options = {}) {
    const list = Array.isArray(hits) ? hits : [];
    if (!list.length) return '';
    const max = clamp(Math.floor(num(options.maxChars, this.opts.maxContextChars)), 120, 4000);
    const header = options.header || '【记忆】';
    const now = Date.now();
    const seen = new Set();
    const lines = [];
    let used = charLen(header) + 1; // 标题 + 换行

    for (const h of list) {
      if (!h) continue;
      const text = cleanText(h.text || '');
      if (!text) continue;
      const dedupeKey = text.slice(0, 40);
      if (seen.has(dedupeKey)) continue;
      const label = this._labelFor(h);
      const age = formatAge(now - num(h.ts, now));
      const fixed = `- [${label}] （${age}）`;
      const room = max - used - charLen(fixed) - 1;
      if (room < 12) break; // 放不下有意义的正文了
      const body = truncateChars(text, room);
      const line = `- [${label}] ${body}（${age}）`;
      const cost = charLen(line) + 1;
      if (used + cost > max) break;
      used += cost;
      seen.add(dedupeKey);
      lines.push(line);
    }
    return lines.length ? `${header}\n${lines.join('\n')}` : '';
  }

  /**
   * @returns {Promise<{nodes:number, edges:number, bytes:number, tombstones:number, dormant:number,
   *                    kinds:Object, files:Object, lines:Object, version:number, dir:string}>}
   */
  async stats() {
    this._assertReady();
    return this._statsSync();
  }

  /**
   * 调试/自检用：用当前语料的 idf 算两段文本的 tf-idf 余弦。
   * 不写盘、不改状态。注意结果依赖库内已有文档（idf 是语料相关的）。
   * @param {string} textA
   * @param {string} textB
   * @param {string[]} [tagsA]
   * @param {string[]} [tagsB]
   * @returns {number}
   */
  similarity(textA, textB, tagsA = [], tagsB = []) {
    const a = { text: cleanText(textA), tags: normalizeTags(tagsA) };
    const b = { text: cleanText(textB), tags: normalizeTags(tagsB) };
    if (!a.text || !b.text) return 0;
    return this._tfidfCosinePair(this._tfFor(a), this._tfFor(b));
  }

  /**
   * 导出全部内存数据（调试 / 迁移用），同步返回。
   * @param {{includeDeleted?:boolean}} [options]
   */
  exportAll(options = {}) {
    const includeDeleted = options.includeDeleted === true;
    const nodes = [];
    for (const n of this.nodes.values()) nodes.push(this._publicNode(n));
    if (includeDeleted) {
      for (const [id, raw] of this._raw) {
        if (this.nodes.has(id)) continue;
        if (raw && raw.deleted) nodes.push(raw);
      }
    }
    const edges = Array.from(this.edgeMap.values()).map((e) => ({ ...e }));
    return {
      app: APP,
      dir: this.dir,
      nodes,
      edges,
      layers: this.layerStats(),
      stats: this._statsSync(),
      scoring: {
        weights: { ...this.weights },
        recallWeights: { ...recallArms.RECALL_WEIGHTS },
        halfLifeDays: this.opts.halfLifeDays,
        decayHalfLifeDays: this.opts.decayHalfLifeDays,
        dormantDays: this.opts.dormantDays,
        dormantPenalty: this.opts.dormantPenalty,
        dedupeThreshold: this.opts.dedupeThreshold,
        consolidateThreshold: this.opts.consolidateThreshold,
        minScore: this.opts.minScore,
        // v2 检索 / 动力学
        recallTopK: this.opts.recallTopK,
        budgetChars: this.opts.budgetChars,
        mmrLambda: this.opts.mmrLambda,
        mmrThreshold: this.opts.mmrThreshold,
        hebbEta: this.opts.hebbEta,
        hebbMinProduct: this.opts.hebbMinProduct,
        archiveRetention: this.opts.archiveRetention,
        archiveMinDays: this.opts.archiveMinDays,
        synapseIdleDays: this.opts.synapseIdleDays,
        synapseDecay: this.opts.synapseDecay,
        hebbianMaxPerNode: this.opts.hebbianMaxPerNode,
        synapseMinWeight: this.opts.synapseMinWeight,
      },
      trace: this._traceLines,
      index: this._indexMeta,
    };
  }

  // -- 记忆星云 v2 公开 API -------------------------------------------------

  /**
   * 四臂召回（词法 / 激活 / 图扩散 / 画像）+ MMR 去冗余 + 片段预算。
   * 命中即按 FSRS 记账，同一次召回共同激活的节点之间加深赫布边，并写 trace.jsonl。
   * @param {string} query
   * @param {{topK?:number, budgetChars?:number, includeArchived?:boolean, includeDormant?:boolean,
   *          trackAccess?:boolean, mmrLambda?:number, mmrThreshold?:number, now?:number}} [options]
   * @returns {Promise<{query:string, ts:number, latencyMs:number, fragments:any[],
   *                    byLayer:Object, text:string, stats:Object, hebbian:Object}>}
   */
  async recallFragments(query, options = {}) {
    this._assertReady();
    const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
    const topK = clamp(Math.floor(num(options.topK, this.opts.recallTopK)), 1, 24);
    const budgetChars = clamp(Math.floor(num(options.budgetChars, this.opts.budgetChars)), 200, 4000);
    const includeArchived = options.includeArchived === true;
    const includeDormant = options.includeDormant === true || includeArchived;
    const trackAccess = options.trackAccess !== false;
    const t0 = Date.now();

    const recalled = recallArms.runRecall(this, query, {
      now,
      topK,
      includeArchived,
      includeDormant,
      mmrLambda: num(options.mmrLambda, this.opts.mmrLambda),
      mmrThreshold: num(options.mmrThreshold, this.opts.mmrThreshold),
    });

    let hebbian = { created: 0, reinforced: 0, pairs: 0 };
    if (trackAccess) {
      for (const p of recalled.picked) {
        const node = this.nodes.get(p.id);
        if (node) dynamics.touchNode(this, node, { now, act: clamp01(p.actNorm) });
      }
      const acts = new Map();
      for (const p of recalled.picked) acts.set(p.id, clamp01(p.actNorm));
      hebbian = dynamics.applyHebbian(this, acts, { now, source: 'recall' });
    }

    const view = fragmentsView.buildFragment({
      mem: this,
      query,
      recall: recalled,
      topK,
      budgetChars,
      now,
    });
    const latencyMs = Date.now() - t0;

    const trace = {
      id: makeId(),
      query: recalled.query.slice(0, 200),
      ts: now,
      latencyMs,
      seeds: recalled.seeds.map((s) => ({ id: s.id, score: round(s.score, 6) })),
      activated: recalled.activated.map((a) => ({
        id: a.id,
        act: round(a.act, 4),
        hop: a.hop,
        arms: a.arms,
      })),
      picked: recalled.picked.map((p) => ({
        id: p.id,
        score: round(p.score, 6),
        arm: p.arm,
        hop: p.hop || 0,
      })),
      // SPEC §3 里 trace.weights 的键是 lex/act/rec —— 面板按这个名字读，别改名
      weights: {
        lex: recalled.weights.lexical,
        act: recalled.weights.activation,
        rec: recalled.weights.recency,
      },
      candidates: recalled.candidates,
      arms: recalled.arms,
      hebbian: { created: hebbian.created, reinforced: hebbian.reinforced, pairs: hebbian.pairs },
    };
    this._writeTrace(trace);
    this._flushPending();
    this._maybeFlushIndex();

    return {
      query: trace.query,
      ts: now,
      latencyMs,
      fragments: view.fragments,
      byLayer: view.byLayer,
      text: view.text,
      stats: {
        candidates: recalled.candidates,
        tokensUsed: recalled.tokensUsed,
        dropped: view.dropped,
        arms: recalled.arms,
      },
      hebbian: trace.hebbian,
      /* m20505：把种子 / 激活 / 配额 pick 一并返回 —— 主进程要把它发给渲染层，
         星云才能按 hop 给种子/1跳/2跳上色（以前只回 fragments，trace 里 seeds 是空的）。 */
      seeds: trace.seeds,
      activated: trace.activated,
      picked: trace.picked,
      trace,
    };
  }

  /**
   * 观察一轮对话：写事件节点（L0）→ 规则抽取记忆片段（L1）→ 连边 → 赫布 → 视情况巩固。
   * @param {{user?:string, assistant?:string, ts?:number}} [input]
   * @returns {Promise<{ok:boolean, eventId?:string, ts?:number, fragments?:any[], links?:number,
   *                    hebbian?:Object, consolidated?:Object|null, durationMs:number}>}
   */
  async observe(input = {}) {
    this._assertReady();
    const t0 = Date.now();
    const now = Number.isFinite(input.ts) ? Number(input.ts) : Date.now();
    const userText = dynamics.truncateChars(cleanText(input.user || ''), 600);
    const assistantText = dynamics.truncateChars(cleanText(input.assistant || ''), 800);
    if (!userText && !assistantText) {
      return { ok: false, error: 'empty', durationMs: Date.now() - t0 };
    }

    this._turnCounter++;
    this._observeTurns++;

    const eventText = assistantText ? `用户：${userText}｜助手：${assistantText}` : `用户：${userText}`;
    const event = await this.remember({
      text: eventText,
      kind: MEM_KIND.EPISODE,
      tags: ['对话'],
      importance: 0.4,
      source: 'chat',
      ts: now,
      layer: LAYER.EVENT,
      meta: { turn: this._turnCounter, role: 'exchange' },
    });

    const extracted = extract.extractMemories({
      userText: input.user || '',
      assistantText: input.assistant || '',
    });
    const fragments = [];
    for (const item of extracted) {
      const rec = await this.remember({
        text: item.text,
        kind: item.kind,
        tags: item.tags,
        importance: item.importance,
        source: 'extract',
        ts: now,
        layer: LAYER.FRAGMENT,
        meta: { fromEvent: event.id },
      });
      fragments.push({
        id: rec.id,
        text: item.text,
        kind: item.kind,
        tags: Array.isArray(item.tags) ? item.tags.slice() : [],
        importance: item.importance,
        deduped: !!rec.deduped,
      });
    }

    // 事件 ↔ 片段：来源边
    let links = 0;
    for (const f of fragments) {
      await this.link(event.id, f.id, 0.7, { kind: EDGE_KIND.SEMANTIC, source: 'observe' });
      links++;
    }
    // 片段之间：语义相近的互相连（这次对话里同时出现的偏好/事实）
    for (let i = 0; i < fragments.length; i++) {
      for (let j = i + 1; j < fragments.length; j++) {
        const a = this.nodes.get(fragments[i].id);
        const b = this.nodes.get(fragments[j].id);
        if (!a || !b) continue;
        const sim = this._tfidfCosinePair(a._tf || this._tfFor(a), b._tf || this._tfFor(b));
        if (sim >= 0.5) {
          await this.link(a.id, b.id, round(0.4 + 0.4 * sim, 4), {
            kind: EDGE_KIND.SEMANTIC,
            source: 'observe',
          });
          links++;
        }
      }
    }

    // 事件与本次抽取的片段共同激活 → 赫布边（带 (1-w) 上界）
    const acts = new Map();
    acts.set(event.id, 0.8);
    for (const f of fragments) acts.set(f.id, clamp01(f.importance));
    const hebbian = dynamics.applyHebbian(this, acts, { now, source: 'observe' });

    this._flushPending();
    let consolidated = null;
    const every = Math.max(1, Math.floor(num(this.opts.observeConsolidateEvery, 20)));
    const dueByCount = this._observeTurns >= every;
    const dueByTime =
      now - num(this._lastConsolidateAt, 0) >=
      Math.max(0.001, num(this.opts.observeConsolidateDays, 1)) * DAY_MS;
    if (dueByCount || dueByTime) {
      consolidated = await this.consolidate();
      this._observeTurns = 0;
    } else {
      this._maybeFlushIndex();
    }

    return {
      ok: true,
      eventId: event.id,
      ts: now,
      fragments,
      links,
      hebbian,
      consolidated: consolidated
        ? {
            ok: true,
            clusters: consolidated.clusters,
            factsCreated: consolidated.factsCreated,
            summaryId: consolidated.summaryId,
          }
        : null,
      durationMs: Date.now() - t0,
    };
  }

  /**
   * 维护扫描：遗忘/归档（R<0.15 且闲置 >90 天）+ 合成边修剪 + 刷新 L3 摘要 + 到期巩固。
   * @param {{dryRun?:boolean, now?:number}} [options]
   * @returns {Promise<{archived:number, edgesDecayed:number, edgesRemoved:number, scanned:number,
   *                    summaryId:string|null, summaryUpdated:boolean, consolidated:Object|null,
   *                    dryRun:boolean, durationMs:number}>}
   */
  async tick(options = {}) {
    this._assertReady();
    const t0 = Date.now();
    const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
    const dryRun = options.dryRun === true;

    const forget = dynamics.forgetPass(this, { now, dryRun });
    let summary = null;
    let consolidated = null;
    if (!dryRun) {
      // L3 画像摘要按 summaryRefreshMs 节流（修复每条 tick 重写，2026-11-24）
      const summaryInterval = Math.max(0, num(this.opts.summaryRefreshMs, 300000));
      const summaryDue =
        summaryInterval === 0 ||
        !this._lastSummaryRefreshAt ||
        now - num(this._lastSummaryRefreshAt, 0) >= summaryInterval;
      if (summaryDue) {
        summary = dynamics.refreshSummary(this, { now });
        this._lastSummaryRefreshAt = now;
      }
      const due =
        !this._lastConsolidateAt ||
        now - num(this._lastConsolidateAt, 0) >=
          Math.max(0.001, num(this.opts.tickConsolidateDays, 1)) * DAY_MS;
      if (due) consolidated = await this.consolidate();
      this._lastTickAt = now;
      this._flushPending();
      this._maybeFlushIndex(true);
      this._writeIndexSnapshot();
    }

    return {
      archived: forget.archived,
      edgesDecayed: forget.edgesDecayed,
      edgesRemoved: forget.edgesRemoved,
      hebbianPruned: forget.hebbianPruned,
      scanned: forget.scanned,
      summaryId: summary ? summary.id : null,
      summaryUpdated: !!(summary && summary.updated),
      consolidated: consolidated
        ? {
            clusters: consolidated.clusters,
            factsCreated: consolidated.factsCreated,
            summaryId: consolidated.summaryId,
          }
        : null,
      dryRun,
      durationMs: Date.now() - t0,
    };
  }

  /** 最近 N 条召回 trace（新的在前）。同步；读 trace.jsonl 尾部，不加载进内存常驻。 */
  getTrace(limit = 20) {
    this._assertReady();
    const n = clamp(Math.floor(num(limit, 20)), 1, 200);
    /** @type {any[]} */
    const rows = [];
    readJsonl(this.fileTrace, (obj) => {
      if (obj && typeof obj === 'object') rows.push(obj);
    });
    return rows.slice(-n).reverse();
  }

  /** 分层 / 边类型 / 遗忘状态统计。同步，面板直接调用。 */
  layerStats() {
    this._assertReady();
    const layers = { event: 0, fragment: 0, summary: 0 };
    const edges = { semantic: 0, hebbian: 0, explicit: 0 };
    let archived = 0;
    let dormant = 0;
    let stabilitySum = 0;
    for (const node of this.nodes.values()) {
      const layer = node.layer || dynamics.layerOf(node.kind);
      layers[layer] = (layers[layer] || 0) + 1;
      if (node.archived) archived++;
      if (node.dormant) dormant++;
      stabilitySum += num(node.stability, 1);
    }
    for (const edge of this.edgeMap.values()) {
      const kind = dynamics.isValidEdgeKind(edge.kind) ? edge.kind : EDGE_KIND.SEMANTIC;
      edges[kind] = (edges[kind] || 0) + 1;
    }
    return {
      layers,
      edges,
      archived,
      dormant,
      avgStability: this.nodes.size ? round(stabilitySum / this.nodes.size, 3) : 0,
      nodes: this.nodes.size,
      edgesTotal: this.edgeMap.size,
      tokens: this.postings.size,
      trace: this._traceLines,
    };
  }

  // -------------------------------------------------------------------------
  // 内部：加载
  // -------------------------------------------------------------------------

  _loadNodes() {
    this.nodes.clear();
    this._raw.clear();
    let invalid = 0;
    const res = readJsonl(this.fileNodes, (obj) => {
      if (!obj || typeof obj !== 'object' || obj.id == null || typeof obj.text !== 'string') {
        invalid++;
        return;
      }
      // 同一 id 后写覆盖先写：天然支持「更新」与 tombstone
      this._raw.set(String(obj.id), obj);
    });
    this._nodeLines = res.lines;
    this._badLines += res.bad + invalid;
    for (const [id, raw] of this._raw) {
      if (raw.deleted) continue; // 软删记录留在 _raw 里，不进索引
      const node = this._adopt(raw);
      if (!node) {
        this._raw.delete(id);
        continue;
      }
      this.nodes.set(id, node);
      this._raw.set(id, this._publicNode(node));
    }
  }

  _loadEdges() {
    this.edgeMap.clear();
    let invalid = 0;
    const res = readJsonl(this.fileEdges, (obj) => {
      if (!obj || typeof obj !== 'object') {
        invalid++;
        return;
      }
      const a = String(obj.a == null ? obj.from : obj.a);
      const b = String(obj.b == null ? obj.to : obj.b);
      if (!a || !b || a === 'undefined' || b === 'undefined' || a === b) {
        invalid++;
        return;
      }
      const key = edgeKey(a, b);
      // 边 tombstone（tick 删除合成边时写）：后写覆盖先写
      if (obj.deleted) {
        this.edgeMap.delete(key);
        return;
      }
      const lo = a < b ? a : b;
      const hi = a < b ? b : a;
      const w = clamp(num(obj.w == null ? obj.weight : obj.w, 1), 0.01, 10);
      const kind = dynamics.isValidEdgeKind(obj.kind) ? obj.kind : EDGE_KIND.SEMANTIC;
      const lastFired = Number.isFinite(obj.lastFired)
        ? Number(obj.lastFired)
        : Number.isFinite(obj.ts)
          ? Number(obj.ts)
          : Date.now();
      const fireCount = Number.isFinite(obj.fireCount) ? Number(obj.fireCount) : 1;
      this.edgeMap.set(key, { a: lo, b: hi, w, kind, lastFired, fireCount });
    });
    this._edgeLines = res.lines;
    this._badLines += res.bad + invalid;
    // 端点不存在的边（对端被 forget / 或压缩前残留）不参与内存图
    for (const [key, e] of this.edgeMap) {
      if (!this.nodes.has(e.a) || !this.nodes.has(e.b)) this.edgeMap.delete(key);
    }
  }

  /** @param {any} raw */
  _adopt(raw) {
    const id = String(raw.id);
    const text = cleanText(raw.text).slice(0, MAX_TEXT);
    if (!text) return null;
    const kind = KIND_SET.has(raw.kind) ? raw.kind : MEM_KIND.EPISODE;
    const ts = Number.isFinite(raw.ts) ? Number(raw.ts) : Date.now();
    return {
      id,
      kind,
      text,
      tags: normalizeTags(raw.tags),
      importance: clamp01(raw.importance == null ? 0.5 : raw.importance),
      ts,
      source: typeof raw.source === 'string' ? raw.source.slice(0, 120) : 'unknown',
      meta: raw.meta && typeof raw.meta === 'object' && !Array.isArray(raw.meta) ? raw.meta : {},
      vec: Array.isArray(raw.vec) ? raw.vec : undefined,
      access: Number.isFinite(raw.access) ? Number(raw.access) : 0,
      lastAccessAt: Number.isFinite(raw.lastAccessAt) ? Number(raw.lastAccessAt) : ts,
      dormant: !!raw.dormant,
      createdAt: Number.isFinite(raw.createdAt) ? Number(raw.createdAt) : ts,
      // v2 分层 / 动力学状态（旧数据缺字段时按 kind 推断，平滑升级）
      layer: dynamics.layerOf(kind, raw.layer),
      stability: clamp(num(raw.stability, 1), 0.05, 3650),
      archived: !!raw.archived,
      archivedAt: Number.isFinite(raw.archivedAt) ? Number(raw.archivedAt) : 0,
      act: clamp01(num(raw.act, 0)),
      actAt: Number.isFinite(raw.actAt) ? Number(raw.actAt) : 0,
      deleted: false,
      _tf: null,
    };
  }

  _loadIndexSnapshotMeta() {
    this._indexMeta = null;
    let payload = null;
    try {
      payload = JSON.parse(fs.readFileSync(this.fileIndex, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') this._log('warn', `index.json 读取失败（将重建）: ${err.message}`);
    }
    if (payload && typeof payload === 'object') {
      this._indexMeta = {
        app: payload.app,
        indexVersion: payload.indexVersion,
        builtAt: payload.builtAt,
        nodes: payload.nodes,
        edges: payload.edges,
        tokens: payload.tokens,
        trace: payload.trace,
        traceSeq: payload.traceSeq,
        lastConsolidateAt: payload.lastConsolidateAt,
        lastTickAt: payload.lastTickAt,
      };
    }
    const stale =
      !this._indexMeta ||
      this._indexMeta.indexVersion !== INDEX_VERSION ||
      this._indexMeta.nodes !== this.nodes.size ||
      this._indexMeta.edges !== this.edgeMap.size;
    if (stale) this._indexDirty = true;
  }

  _rebuildDerived() {
    this.postings.clear();
    this.df.clear();
    this._idfCache.clear();
    this._idfVersion = -1;
    this.adj.clear();
    for (const node of this.nodes.values()) {
      node._tf = this._tfFor(node);
      this._indexNode(node);
    }
    for (const e of this.edgeMap.values()) this._applyEdgeToAdj(e);
    this._dfVersion++;
  }

  // -------------------------------------------------------------------------
  // 内部：索引
  // -------------------------------------------------------------------------

  /** 节点 token 频次：正文 + 标签（标签也算一次，便于按主题召回） */
  _tfFor(node) {
    const freq = tx.termFreq(node.text);
    for (const tag of node.tags || []) {
      for (const t of tx.tokenize(tag)) freq.set(t, (freq.get(t) || 0) + 1);
    }
    return freq;
  }

  _indexNode(node) {
    for (const token of node._tf.keys()) {
      let set = this.postings.get(token);
      if (!set) {
        set = new Set();
        this.postings.set(token, set);
      }
      if (set.has(node.id)) continue;
      set.add(node.id);
      this.df.set(token, (this.df.get(token) || 0) + 1);
    }
  }

  _unindexNode(node) {
    if (!node._tf) return;
    for (const token of node._tf.keys()) {
      const set = this.postings.get(token);
      if (!set) continue;
      if (!set.delete(node.id)) continue;
      const n = (this.df.get(token) || 0) - 1;
      if (n > 0) this.df.set(token, n);
      else {
        this.df.delete(token);
        this.postings.delete(token);
      }
    }
  }

  // -------------------------------------------------------------------------
  // 内部：写盘
  // -------------------------------------------------------------------------

  _publicNode(n) {
    /** @type {any} */
    const rec = {
      id: n.id,
      kind: n.kind,
      text: n.text,
      tags: n.tags.slice(),
      importance: round(n.importance, 4),
      ts: n.ts,
      source: n.source,
      meta: n.meta || {},
      access: n.access || 0,
      lastAccessAt: n.lastAccessAt || n.ts,
      dormant: !!n.dormant,
      layer: n.layer || dynamics.layerOf(n.kind),
    };
    // v2 动力学状态：只落非默认值，保持 jsonl 紧凑（缺省即 1.0 / false / 0）
    if (n.stability != null && n.stability !== 1) rec.stability = round(n.stability, 4);
    if (n.archived) {
      rec.archived = true;
      if (n.archivedAt) rec.archivedAt = n.archivedAt;
    }
    if (n.act) {
      rec.act = round(n.act, 4);
      if (n.actAt) rec.actAt = n.actAt;
    }
    if (n.vec) rec.vec = n.vec;
    if (n.createdAt) rec.createdAt = n.createdAt;
    if (n.deleted) {
      rec.deleted = true;
      rec.deletedAt = n.deletedAt || Date.now();
    }
    return rec;
  }

  _appendNode(n) {
    const rec = this._publicNode(n);
    appendLine(this.fileNodes, rec);
    this._raw.set(n.id, rec);
    this._nodeLines++;
    this._writesSinceIndex++;
    this._scheduleAutoCompact();
  }

  _addEdge(a, b, weight, meta = {}) {
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const w = clamp(num(weight, 1), 0.01, 10);
    const now = Date.now();
    const kind = dynamics.isValidEdgeKind(meta.kind) ? meta.kind : EDGE_KIND.SEMANTIC;
    const edge = {
      a: lo,
      b: hi,
      w,
      kind,
      lastFired: Number.isFinite(meta.lastFired) ? Number(meta.lastFired) : now,
      fireCount: Number.isFinite(meta.fireCount) ? Number(meta.fireCount) : 1,
    };
    // 溯源标记（chunk = 同一文档切块间的关联；缺省不写入，保持旧数据形状）
    if (meta.source) edge.source = String(meta.source).slice(0, 32);
    this.edgeMap.set(edgeKey(lo, hi), edge);
    this._saveEdge(edge);
    this._applyEdgeToAdj(edge);
    return edge;
  }

  /** 追加一行边记录（同一对端点后写覆盖先写） */
  _saveEdge(edge) {
    appendLine(this.fileEdges, { ...edge, ts: Date.now() });
    this._edgeLines++;
    this._writesSinceIndex++;
  }

  /** 更新边权重 / 动力学字段（追加写 + 内存 & 邻接表同步） */
  _updateEdge(edge, patch = {}) {
    Object.assign(edge, patch);
    edge.w = clamp(num(edge.w, 0), 0.001, 10);
    this._saveEdge(edge);
    this._applyEdgeToAdj(edge);
    return edge;
  }

  /** 删除边：内存摘除 + 写 tombstone（{a,b,deleted:true}） */
  _removeEdge(edge) {
    this.edgeMap.delete(edgeKey(edge.a, edge.b));
    const ma = this.adj.get(edge.a);
    if (ma) ma.delete(edge.b);
    const mb = this.adj.get(edge.b);
    if (mb) mb.delete(edge.a);
    appendLine(this.fileEdges, { a: edge.a, b: edge.b, deleted: true, ts: Date.now() });
    this._edgeLines++;
    this._writesSinceIndex++;
  }

  /** 插入一条已构造好的节点（L3 摘要用；不走去重） */
  _insertNode(node) {
    this.nodes.set(node.id, node);
    this._indexNode(node);
    this._appendNode(node);
    this.version++;
    this._dfVersion++;
    this._indexDirty = true;
    this._maybeFlushIndex();
    return node;
  }

  /** 原地重写节点（文本会重算倒排；摘要刷新用） */
  _rewriteNode(node, patch = {}) {
    this._unindexNode(node);
    Object.assign(node, patch);
    node._tf = this._tfFor(node);
    this._indexNode(node);
    this._appendNode(node);
    this.version++;
    this._dfVersion++;
    this._indexDirty = true;
    this._maybeFlushIndex();
    return node;
  }

  /** 访问状态批量落盘（攒够 pendingFlushAt 条再写，减少写放大） */
  _queuePersist(node) {
    this._pending.add(node.id);
    this.version++;
    if (this._pending.size >= this.opts.pendingFlushAt) this._flushPending();
  }

  _applyEdgeToAdj(edge) {
    let ma = this.adj.get(edge.a);
    if (!ma) {
      ma = new Map();
      this.adj.set(edge.a, ma);
    }
    ma.set(edge.b, edge.w);
    let mb = this.adj.get(edge.b);
    if (!mb) {
      mb = new Map();
      this.adj.set(edge.b, mb);
    }
    mb.set(edge.a, edge.w);
  }

  _removeEdgesOf(id) {
    const adj = this.adj.get(id);
    if (adj) {
      for (const other of adj.keys()) {
        const back = this.adj.get(other);
        if (back) back.delete(id);
      }
      this.adj.delete(id);
    }
    for (const [key, e] of this.edgeMap) {
      if (e.a === id || e.b === id) this.edgeMap.delete(key);
    }
  }

  // -------------------------------------------------------------------------
  // 内部：trace 日志（每次召回一行，保留最近 traceMax 条）
  // -------------------------------------------------------------------------

  _writeTrace(trace) {
    const rec = { ...trace, seq: ++this._traceSeq };
    appendLine(this.fileTrace, rec);
    this._traceLines++;
    if (this._traceLines > num(this.opts.traceMax, 200)) this._compactTrace();
    return rec;
  }

  _compactTrace() {
    /** @type {any[]} */
    const rows = [];
    readJsonl(this.fileTrace, (obj) => {
      if (obj && typeof obj === 'object') rows.push(obj);
    });
    const keep = rows.slice(-Math.max(1, Math.floor(num(this.opts.traceMax, 200))));
    const text = keep.length ? keep.map((r) => JSON.stringify(r)).join('\n') + '\n' : '';
    atomicWrite(this.fileTrace, text);
    this._traceLines = keep.length;
    if (keep.length) this._traceSeq = Math.max(num(keep[keep.length - 1].seq, 0), this._traceSeq);
    this._log('debug', `compacted trace.jsonl -> ${keep.length} lines`);
  }

  _maybeFlushIndex(force = false) {
    if (!this._indexDirty) return;
    if (!force && this._writesSinceIndex < this.opts.indexFlushEvery) return;
    this._writeIndexSnapshot();
  }

  /**
   * 把「扁平旧库」一次性落成完整快照（全部节点重写回文件）。
   *
   * 为什么要它：记忆库改成「每个形象一个目录」后，启动时第一个实例仍然打开旧的扁平目录。
   * 如果那个目录里是全量节点、但文件只有部分内容（或索引里 node 数对不上文件），
   * 随后任何一次写入都会触发压缩，把文件重写成「只有内存里那些节点」——
   * 别的形象库在升级后第一次被打开时就会这样把旧记忆吃掉。
   * 这里在启动阶段先把扁平库写成自洽的完整快照，之后再打开就不会误判、不会压缩丢数据。
   * @returns {{ok:boolean, nodes:number, compacted:boolean}}
   */
  async snapshotFlat() {
    if (!this._ready) return { ok: false, nodes: 0, compacted: false };
    const onDisk = this._nodeLines + this._pending.size;
    const complete = onDisk === this.nodes.size;
    // 节点全在、索引也是这次启动刚写下的 → 已经自洽，什么都不用做
    if (complete && !this._indexDirty) {
      this._log('info', `snapshot dir=${this.dir} nodes=${this.nodes.size} onDiskBefore=${onDisk} compacted=false skipped=true`);
      return { ok: true, nodes: this.nodes.size, compacted: false };
    }
    // 文件里的行数对不上内存里的节点数 → 强制整库重写，让文件重新变得「完整」
    const needCompact = !complete;
    if (needCompact) {
      this._compactNodesNow = true;
      this._maybeCompact();
      this._compactNodesNow = false;
    }
    this._flushPending();
    this._writeIndexSnapshot();
    this._log('info', `snapshot dir=${this.dir} nodes=${this.nodes.size} onDiskBefore=${onDisk} compacted=${needCompact}`);
    return { ok: true, nodes: this.nodes.size, compacted: needCompact };
  }
  _writeIndexSnapshot() {
    /** 注意：用 null 原型，避免 token 恰好叫 "__proto__" 时改坏对象 */
    const postings = Object.create(null);
    for (const [token, ids] of this.postings) {
      if (ids.size) postings[token] = Array.from(ids);
    }
    const payload = {
      app: APP,
      indexVersion: INDEX_VERSION,
      builtAt: new Date().toISOString(),
      dir: this.dir,
      nodes: this.nodes.size,
      edges: this.edgeMap.size,
      tokens: this.postings.size,
      trace: this._traceLines,
      traceSeq: this._traceSeq,
      lastConsolidateAt: this._lastConsolidateAt,
      lastTickAt: this._lastTickAt,
      postings,
    };
    atomicWrite(this.fileIndex, JSON.stringify(payload));
    this._indexDirty = false;
    this._writesSinceIndex = 0;
    this._indexMeta = {
      app: APP,
      indexVersion: INDEX_VERSION,
      builtAt: payload.builtAt,
      nodes: payload.nodes,
      edges: payload.edges,
      tokens: payload.tokens,
      trace: payload.trace,
      traceSeq: payload.traceSeq,
      lastConsolidateAt: payload.lastConsolidateAt,
      lastTickAt: payload.lastTickAt,
    };
  }

  _flushPending() {
    if (!this._pending.size) return 0;
    let written = 0;
    for (const id of this._pending) {
      const node = this.nodes.get(id);
      if (!node) continue;
      this._appendNode(node);
      written++;
    }
    this._pending.clear();
    return written;
  }

  _maybeCompact() {
    const nodeLimit = Math.max(200, Math.floor(this.nodes.size * this.opts.compactionRatio));
    if (this._compactNodesNow || this._nodeLines > nodeLimit) {
      const lines = [];
      for (const n of this.nodes.values()) lines.push(JSON.stringify(this._publicNode(n)));
      atomicWrite(this.fileNodes, lines.length ? lines.join('\n') + '\n' : '');
      this._nodeLines = lines.length;
      this._log('info', `compacted nodes.jsonl -> ${lines.length} lines`);
    }
    const edgeLimit = Math.max(200, Math.floor(this.edgeMap.size * this.opts.compactionRatio));
    if (this._compactNodesNow || this._edgeLines > edgeLimit) {
      const lines = [];
      for (const e of this.edgeMap.values()) lines.push(JSON.stringify(e));
      atomicWrite(this.fileEdges, lines.length ? lines.join('\n') + '\n' : '');
      this._edgeLines = lines.length;
      this._log('info', `compacted edges.jsonl -> ${lines.length} lines`);
    }
  }

  // -------------------------------------------------------------------------
  // 内部：打分
  // -------------------------------------------------------------------------

  _idf(token) {
    if (this._idfVersion !== this._dfVersion) {
      this._idfCache.clear();
      this._idfVersion = this._dfVersion;
    }
    let v = this._idfCache.get(token);
    if (v !== undefined) return v;
    const n = Math.max(1, this.nodes.size);
    const df = this.df.get(token) || 0;
    // BM25 式平滑，恒 > 0
    v = Math.log(1 + (n - df + 0.5) / (df + 0.5));
    if (!(v > 0)) v = 1e-4;
    this._idfCache.set(token, v);
    return v;
  }

  /** @param {string} query */
  _queryVector(query) {
    const freq = tx.termFreq(query);
    const w = new Map();
    let sum = 0;
    for (const [token, tf] of freq) {
      const weight = (1 + Math.log(tf)) * this._idf(token);
      if (!(weight > 0)) continue;
      w.set(token, weight);
      sum += weight * weight;
    }
    return { w, norm: Math.sqrt(sum), tokens: Array.from(freq.keys()) };
  }

  /**
   * 文档向量（tf-idf）与查询向量的余弦。
   * @param {Map<string, number>} tf
   * @param {{w: Map<string, number>, norm: number}} qv
   */
  _tfidfCosine(tf, qv) {
    if (!tf || !tf.size || !qv.norm) return 0;
    let dot = 0;
    let docSum = 0;
    for (const [token, f] of tf) {
      const idf = this._idf(token);
      const weight = (1 + Math.log(f)) * idf;
      docSum += weight * weight;
      const q = qv.w.get(token);
      if (q) dot += weight * q;
    }
    if (!dot || !docSum) return 0;
    return dot / (qv.norm * Math.sqrt(docSum) + 1e-12);
  }

  /**
   * 两个节点 tf 向量的 tf-idf 余弦（去重 / 巩固用）。
   * @param {Map<string, number>} tfA
   * @param {Map<string, number>} tfB
   */
  _tfidfCosinePair(tfA, tfB) {
    if (!tfA || !tfB || !tfA.size || !tfB.size) return 0;
    let dot = 0;
    let sumA = 0;
    let sumB = 0;
    for (const [token, f] of tfA) {
      const idf = this._idf(token);
      const wa = (1 + Math.log(f)) * idf;
      sumA += wa * wa;
      const fb = tfB.get(token);
      if (fb) dot += wa * ((1 + Math.log(fb)) * idf);
    }
    for (const [token, f] of tfB) {
      const wb = (1 + Math.log(f)) * this._idf(token);
      sumB += wb * wb;
    }
    if (!dot) return 0;
    return dot / (Math.sqrt(sumA) * Math.sqrt(sumB) + 1e-12);
  }

  /** 邻居加成：候选集内相连边的权重和 */
  _neighborWeight(id, candSet) {
    const adj = this.adj.get(id);
    if (!adj) return 0;
    let sum = 0;
    for (const [other, w] of adj) {
      if (candSet.has(other) && this.nodes.has(other)) sum += w;
    }
    return sum;
  }

  /**
   * 同 kind 去重查找。
   * @param {any} rec 带 _tf 的新记录
   */
  _findDuplicate(rec) {
    const threshold = num(this.opts.dedupeThreshold, 0.92);
    const cand = new Set();
    for (const token of rec._tf.keys()) {
      const ids = this.postings.get(token);
      if (!ids) continue;
      for (const id of ids) cand.add(id);
    }
    let best = null;
    let bestSim = 0;
    for (const id of cand) {
      const n = this.nodes.get(id);
      if (!n || n.kind !== rec.kind) continue;
      const sim = this._tfidfCosinePair(rec._tf, n._tf);
      if (sim > bestSim) {
        bestSim = sim;
        best = n;
      }
    }
    return bestSim > threshold ? best : null;
  }

  /** 兼容旧接口：访问记账现在统一走 FSRS（dynamics.touchNode）。 */
  _touch(node) {
    dynamics.touchNode(this, node, { act: 0 });
  }

  // -------------------------------------------------------------------------
  // 内部：构造 / 巩固 / 统计
  // -------------------------------------------------------------------------

  _buildRecord(input) {
    const text = cleanText(input.text).slice(0, MAX_TEXT);
    if (!text) throw new TypeError('memory: remember({ text }) 需要非空文本');
    let kind = MEM_KIND.EPISODE;
    if (input.kind != null) {
      if (KIND_SET.has(input.kind)) kind = input.kind;
      else this._log('warn', `remember: 未知 kind "${input.kind}"，按 episode 处理`);
    }
    const now = Date.now();
    const ts = Number.isFinite(input.ts) && input.ts > 0 ? Number(input.ts) : now;
    /** @type {any} */
    const node = {
      id: makeId(),
      kind,
      text,
      tags: normalizeTags(input.tags),
      importance: clamp01(input.importance == null ? 0.5 : input.importance),
      ts,
      source: typeof input.source === 'string' && input.source ? input.source.slice(0, 120) : 'unknown',
      meta: sanitizeMeta(input.meta),
      vec: Array.isArray(input.vec) ? input.vec.slice(0, 512).map(Number).filter(Number.isFinite) : undefined,
      access: 0,
      lastAccessAt: ts,
      dormant: false,
      // v2：分层 + 动力学初始状态
      layer: dynamics.layerOf(kind, input.layer),
      stability: clamp(num(input.stability, 1), 0.05, 3650),
      archived: false,
      archivedAt: 0,
      act: clamp01(num(input.act, 0)),
      actAt: 0,
      createdAt: now,
      deleted: false,
      _tf: null,
    };
    return node;
  }

  /**
   * 由一簇相似 episode 生成 fact 草稿：代表句 + 共性片段（最长公共子串），不用 LLM。
   * @param {any[]} members
   * @param {number} now
   */
  _buildFactDraft(members, now) {
    const rep = members
      .slice()
      .sort((a, b) => b.importance - a.importance || b.text.length - a.text.length)[0];
    let lcs = '';
    for (const m of members) {
      if (m.id === rep.id) continue;
      const c = tx.longestCommonSubstring(rep.text, m.text);
      if (c.length > lcs.length) lcs = c;
    }
    const cleaned = (lcs || '').replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, '');
    let text = rep.text;
    if (cleaned.length >= 4 && !rep.text.includes(cleaned)) text = `${rep.text}（共性：${cleaned}）`;

    const tagCount = new Map();
    let maxImp = 0;
    for (const m of members) {
      maxImp = Math.max(maxImp, m.importance);
      for (const t of m.tags) tagCount.set(t, (tagCount.get(t) || 0) + 1);
    }
    const tags = Array.from(tagCount.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([t]) => t);
    tags.push('汇总');

    /** @type {any} */
    const draft = {
      id: makeId(),
      kind: MEM_KIND.FACT,
      text: text.slice(0, 200),
      tags: normalizeTags(tags),
      importance: clamp01(0.35 + 0.08 * Math.min(members.length, 6) + 0.25 * maxImp),
      ts: now,
      source: 'consolidate',
      meta: { from: members.map((m) => m.id), clusterSize: members.length, consolidatedAt: now },
      access: 0,
      lastAccessAt: now,
      dormant: false,
      layer: LAYER.FRAGMENT,
      stability: 1,
      archived: false,
      archivedAt: 0,
      act: 0,
      actAt: 0,
      createdAt: now,
      deleted: false,
    };
    draft._tf = this._tfFor(draft);
    return draft;
  }

  _labelFor(h) {
    if (h && h.meta && typeof h.meta === 'object' && typeof h.meta.label === 'string' && h.meta.label) {
      return h.meta.label;
    }
    const tags = Array.isArray(h && h.tags) ? h.tags : [];
    for (const p of LABEL_PRIORITY) {
      if (tags.includes(p)) return LABEL_ALIAS[p] || p;
    }
    return KIND_LABEL[(h && h.kind) || ''] || '记忆';
  }

  _statsSync() {
    const files = {};
    let bytes = 0;
    for (const [key, file] of [
      ['nodes', this.fileNodes],
      ['edges', this.fileEdges],
      ['index', this.fileIndex],
      ['trace', this.fileTrace],
    ]) {
      let size = 0;
      try {
        size = fs.statSync(file).size;
      } catch {
        size = 0;
      }
      files[key] = size;
      bytes += size;
    }
    const kinds = {};
    const layers = { event: 0, fragment: 0, summary: 0 };
    let dormant = 0;
    let archived = 0;
    let stabilitySum = 0;
    for (const n of this.nodes.values()) {
      kinds[n.kind] = (kinds[n.kind] || 0) + 1;
      if (n.dormant) dormant++;
      if (n.archived) archived++;
      const layer = n.layer || dynamics.layerOf(n.kind);
      layers[layer] = (layers[layer] || 0) + 1;
      stabilitySum += num(n.stability, 1);
    }
    const tombstones = Array.from(this._raw.values()).filter((raw) => raw && raw.deleted).length;
    return {
      nodes: this.nodes.size,
      edges: this.edgeMap.size,
      bytes,
      tombstones,
      dormant,
      archived,
      layers,
      avgStability: this.nodes.size ? round(stabilitySum / this.nodes.size, 3) : 0,
      kinds,
      files,
      lines: { nodes: this._nodeLines, edges: this._edgeLines, trace: this._traceLines },
      tokens: this.postings.size,
      version: this.version,
      dir: this.dir,
    };
  }
}

module.exports = {
  NebulaMemory,
  assertSafeDir,
  DEFAULTS,
  DEFAULT_WEIGHTS,
  LAYER: dynamics.LAYER,
  EDGE_KIND: dynamics.EDGE_KIND,
  RECALL_WEIGHTS: recallArms.RECALL_WEIGHTS,
  // 供工具/调试复用
  formatAge,
  cleanText,
  atomicWrite,
  readJsonl,
};
