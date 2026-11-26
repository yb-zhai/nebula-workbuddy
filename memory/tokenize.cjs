'use strict';

/**
 * 记忆星云 Lite — 分词 / 停用词 / 相似度工具
 *
 * 设计目标（零依赖、纯本地、可解释）：
 *  - 中文没有第三方分词库，采用「连续汉字二元组（bigram）+ 单字兜底 + ASCII 词」；
 *  - 二元组保留词序信息，比单字召回更准；单字只在整段被停用词吃掉时兜底；
 *  - 停用词同时按「单字」和「双字词」两个粒度过滤，避免「的/了/吗/什么/怎么」污染向量；
 *  - 所有函数都是纯函数，不碰磁盘，方便单独测试。
 */

// ---------------------------------------------------------------------------
// 停用词
// ---------------------------------------------------------------------------

/**
 * 单字停用词：契约里给定的那一串，去重后逐字拆开。
 * 的了吗呢吧啊我你他她它是在有和就不都一个上也很到说要去会着没有看好自己这那什么怎么
 */
const STOPWORD_CHARS = new Set([
  '的', '了', '吗', '呢', '吧', '啊', '我', '你', '他', '她', '它', '是', '在',
  '有', '和', '就', '不', '都', '一', '个', '上', '也', '很', '到', '说', '要',
  '去', '会', '着', '没', '看', '好', '自', '己', '这', '那', '什', '么', '怎',
  // 少量高频虚词/语气词，进一步压噪（不涉及实义词）
  '呀', '哦', '嗯', '哈', '嘛', '呗', '吧', '被', '把', '给', '对', '与', '及',
  '或', '而', '但', '却', '还', '又', '再', '才', '已', '经', '过', '得', '地',
  '之', '其', '此', '该', '每', '各', '些', '样', '能', '可', '让', '从', '向',
]);

/** 双字以上停用词（契约里出现的「没有/一个/什么/怎么/自己」+ 常见功能词） */
const STOPWORDS = new Set([
  '没有', '一个', '什么', '怎么', '自己', '这个', '那个', '哪个', '这些', '那些',
  '我们', '你们', '他们', '她们', '它们', '咱们', '大家', '别人',
  '就是', '不是', '还是', '也是', '都是', '但是', '因为', '所以', '如果', '虽然',
  '然后', '而且', '并且', '或者', '不是', '可以', '可能', '应该', '需要', '必须',
  '已经', '正在', '还是', '这样', '那样', '怎么样', '为什么', '是不是', '有没有',
  '一下', '一点', '一些', '一样', '一起', '一直', '一定', '一般', '一边',
  '时候', '现在', '刚才', '马上', '立刻', '突然', '终于', '其实', '当然',
  '知道', '觉得', '认为', '感觉', '希望', '打算', '准备', '开始', '结束',
  '东西', '事情', '地方', '方面', '问题', '情况', '样子', '意思',
  '好的', '好吧', '行吧', '谢谢', '你好', '您好', '再见', '拜拜',
  '非常', '特别', '十分', '比较', '有点', '有点', '真的', '确实',
]);

// ---------------------------------------------------------------------------
// 正字法归一
// ---------------------------------------------------------------------------

/**
 * 归一化：NFKC（全角 → 半角）、小写、折叠空白。
 * NFKC 会把「，」「？」「Ａ」「１」这类兼容字符折叠成 ASCII，方便后续正则。
 * @param {*} text
 * @returns {string}
 */
function normalizeText(text) {
  if (text == null) return '';
  let s = String(text);
  try {
    s = s.normalize('NFKC');
  } catch {
    /* 孤代理等异常输入：保持原样 */
  }
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// 分词
// ---------------------------------------------------------------------------

const RE_ASCII_WORD = /[a-z0-9][a-z0-9]*(?:[._+#\-/][a-z0-9]+)*/g;
const RE_CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff]+/g;

/** 纯数字 token 至少两位（"2" 这种噪音不要，"16" "2024" 保留） */
const RE_PURE_DIGITS = /^[0-9]+$/;

/** 单字母里最常见的英文虚词，直接丢 */
const ASCII_STOP = new Set(['a', 'i', 'an', 'the', 'of', 'to', 'is', 'it', 'and', 'or', 'in', 'on', 'at', 'by', 'be', 'as', 'my', 'me', 'we', 'us', 'do']);

/** 疑问/语气类的边缘字：以它们开头的 bigram 基本是噪音（「么人」「哈啊」），直接丢 */
const EDGE_NOISE_CHARS = new Set(['么', '什', '怎', '哪', '谁', '哈', '啊', '哦', '嗯', '呀', '嘛', '吧', '呢', '吗']);

/** 结构助词：出现在整段里说明这段是短语而不是词，不做整段 token */
const PARTICLE_CHARS = new Set(['的', '了', '吗', '呢', '吧', '啊', '着', '过']);

/**
 * 判断一个中文 bigram 是否该被丢掉。
 * 规则：整词命中停用词表 / 两个字都是停用字（如「是在」「的了」）/ 以疑问语气字开头。
 * 只丢「双停用字」是为了保住「上网」「下午」这类以虚词起头的实义词。
 */
function isStopBigram(bi) {
  if (STOPWORDS.has(bi)) return true;
  if (EDGE_NOISE_CHARS.has(bi[0])) return true;
  if (PARTICLE_CHARS.has(bi[1])) return true;
  return STOPWORD_CHARS.has(bi[0]) && STOPWORD_CHARS.has(bi[1]);
}

/**
 * 中文切词：bigram 为主，单字兜底。
 * @param {string} run 纯汉字串
 * @param {(t: string) => void} push
 */
function pushCjkTokens(run, push) {
  const L = run.length;
  if (L === 0) return;
  if (L === 1) {
    if (!STOPWORD_CHARS.has(run)) push(run);
    return;
  }
  let produced = 0;
  const seen = new Set();
  for (let i = 0; i < L - 1; i++) {
    const bi = run.slice(i, i + 2);
    if (isStopBigram(bi)) continue;
    if (seen.has(bi)) continue;
    seen.add(bi);
    push(bi);
    produced++;
  }
  // 短词整段也留一份（「程序员」「咖啡」这类 2~4 字词整词命中更准；已作为 bigram 出现的不重复计）
  const wholeUsable =
    L <= 4 &&
    !STOPWORDS.has(run) &&
    !seen.has(run) &&
    !STOPWORD_CHARS.has(run[0]) &&
    !Array.from(run).some((ch) => PARTICLE_CHARS.has(ch)) &&
    !/^(.)\1+$/.test(run); // 叠字（哈哈哈哈）不算词
  if (wholeUsable) push(run);
  // 单字兜底：整段都被停用词吃掉时，退回非停用单字，避免完全检索不到
  if (produced === 0 && !wholeUsable) {
    for (const ch of run) {
      if (!STOPWORD_CHARS.has(ch)) push(ch);
    }
  }
}

/**
 * 切词：返回 token 数组（可能含重复，用于 tf 统计）。
 * 中文 bigram + 单字兜底 + ASCII 词；大小写不敏感。
 * @param {*} text
 * @returns {string[]}
 */
function tokenize(text) {
  const s = normalizeText(text);
  if (!s) return [];
  const out = [];

  // ASCII / 数字词
  RE_ASCII_WORD.lastIndex = 0;
  let m;
  while ((m = RE_ASCII_WORD.exec(s)) !== null) {
    const w = m[0];
    if (RE_PURE_DIGITS.test(w) && w.length < 2) continue;
    if (w.length >= 2 && ASCII_STOP.has(w)) continue;
    if (w.length === 1 && ASCII_STOP.has(w)) continue;
    out.push(w);
    // 复合词额外补子词：node.js → node / js；tf-idf → tf / idf
    if (/[._+#\-/]/.test(w)) {
      for (const part of w.split(/[._+#\-/]+/)) {
        if (part.length >= 2 && !ASCII_STOP.has(part)) out.push(part);
      }
    }
  }

  // 中文
  RE_CJK_RUN.lastIndex = 0;
  while ((m = RE_CJK_RUN.exec(s)) !== null) {
    pushCjkTokens(m[0], (t) => out.push(t));
  }

  return out;
}

/**
 * term frequency：token -> 次数。接受字符串或 token 数组。
 * @param {string|string[]} input
 * @returns {Map<string, number>}
 */
function termFreq(input) {
  /** @type {Map<string, number>} */
  const freq = new Map();
  const tokens = Array.isArray(input) ? input : tokenize(input);
  for (const t of tokens) {
    if (!t) continue;
    freq.set(t, (freq.get(t) || 0) + 1);
  }
  return freq;
}

/**
 * 词集合（去重）。
 * @param {string|string[]} input
 * @returns {Set<string>}
 */
function tokenSet(input) {
  const tokens = Array.isArray(input) ? input : tokenize(input);
  return new Set(tokens.filter(Boolean));
}

// ---------------------------------------------------------------------------
// 相似度
// ---------------------------------------------------------------------------

/**
 * 把 Map / 数组 / 普通对象统一成 entries。
 * @param {Map<string, number>|number[]|Object<string, number>|null|undefined} v
 * @returns {Array<[any, number]>}
 */
function entriesOf(v) {
  if (!v) return [];
  if (v instanceof Map) return Array.from(v.entries());
  if (Array.isArray(v)) return v.map((x, i) => [i, x]);
  if (typeof v === 'object') return Object.entries(v);
  return [];
}

/**
 * 余弦相似度。支持稀疏 Map（检索）、数组（测试）、普通对象（调试）。
 * @param {Map<string, number>|number[]|Object<string, number>} a
 * @param {Map<string, number>|number[]|Object<string, number>} b
 * @returns {number} 0..1（权重非负时）
 */
function cosine(a, b) {
  const ea = entriesOf(a);
  const eb = entriesOf(b);
  if (!ea.length || !eb.length) return 0;
  const mapB = new Map(eb);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [, v] of ea) na += v * v;
  for (const [, v] of eb) nb += v * v;
  if (na === 0 || nb === 0) return 0;
  for (const [k, v] of ea) {
    const w = mapB.get(k);
    if (w) dot += v * w;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-12);
}

/**
 * Jaccard 相似度（集合交并比）。
 * @param {Iterable<string>|string|Set<string>} a
 * @param {Iterable<string>|string|Set<string>} b
 * @returns {number}
 */
function jaccard(a, b) {
  const toSet = (v) => {
    if (v instanceof Set) return v;
    if (typeof v === 'string') return new Set(tokenize(v));
    if (Array.isArray(v)) return new Set(v);
    return new Set(v ? Array.from(v) : []);
  };
  const sa = toSet(a);
  const sb = toSet(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  const [small, big] = sa.size <= sb.size ? [sa, sb] : [sb, sa];
  for (const t of small) if (big.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/**
 * 最长公共子串（用于 consolidate 拼事实文本，不用 LLM）。
 * O(n*m) 时间、O(min(n,m)) 空间。
 * @param {string} a
 * @param {string} b
 * @returns {string}
 */
function longestCommonSubstring(a, b) {
  const s1 = String(a == null ? '' : a);
  const s2 = String(b == null ? '' : b);
  if (!s1 || !s2) return '';
  const n = s1.length;
  const m = s2.length;
  let prev = new Uint16Array(m + 1);
  let cur = new Uint16Array(m + 1);
  let best = 0;
  let bestEnd = 0;
  for (let i = 1; i <= n; i++) {
    const c1 = s1.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      if (c1 === s2.charCodeAt(j - 1)) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) {
          best = cur[j];
          bestEnd = i;
        }
      } else {
        cur[j] = 0;
      }
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
    cur.fill(0);
  }
  return best > 0 ? s1.slice(bestEnd - best, bestEnd) : '';
}

/**
 * 文本相似度快捷方式：纯 tf 余弦（不做 idf，供去重粗判/调试用）。
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function textSimilarity(a, b) {
  return cosine(termFreq(a), termFreq(b));
}

module.exports = {
  STOPWORD_CHARS,
  STOPWORDS,
  normalizeText,
  tokenize,
  termFreq,
  tokenSet,
  cosine,
  jaccard,
  longestCommonSubstring,
  textSimilarity,
};
