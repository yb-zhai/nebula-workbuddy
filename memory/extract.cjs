'use strict';

/**
 * 记忆星云 Lite — 规则式记忆抽取
 *
 * 输入一轮对话（用户/助手文本），输出「值得长期记住」的候选记忆。
 *
 * 原则：**保守优先**。宁可少抽 3 条，也不要抽错 1 条 ——
 * 错误记忆会一直污染检索，而漏抽只是这一次没记住。
 *
 * 因此：
 *  1. 只认少量高置信句式（我叫/我喜欢/我在做/我用的是/记住…）；
 *  2. 每个候选都过 `looksLikeFact()` 质量闸（长度 6~120、非问句、非寒暄、非空壳）；
 *  3. 身份句还额外过谓词黑名单（「我是来问一下的」这种不会被当成身份）；
 *  4. 助手文本目前**不参与抽取**（助手说「记住了」不等于用户说了事实），仅作为签名的一部分预留。
 */

const { MEM_KIND } = require('../shared/constants.cjs');

/** 单次抽取上限：一轮对话说太多「偏好」是可疑的，截断更安全 */
const MAX_ITEMS = 6;
/** 记忆文本长度闸门（字） */
const MIN_LEN = 6;
const MAX_LEN = 120;
/** 抽取值本身的长度上限（防止吞掉整段话） */
const MAX_VALUE_LEN = 40;

// ---------------------------------------------------------------------------
// 质量闸
// ---------------------------------------------------------------------------

const GREETING_RE =
  /^(你好|您好|嗨+|哈+|嗯+|哦+|啊+|早|早上好|中午好|下午好|晚上好|晚安|再见|拜拜|谢谢|多谢|好的|好滴|收到|明白|了解|ok|okay|yes|no|hi|hello|hey)[\s!！。.,，~～]*$/i;

/** 明显的空壳/占位/口头语 */
const EMPTY_SHELL_RE = /^(这个|那个|这些|那些|东西|事情|什么|啥|随便|无所谓|还行|一般般|不好说|不知道|看你|都行|都可以)$/;

/**
 * 质量闸：这个候选值不值得写进记忆？
 * @param {string} text 归一化后的候选记忆文本（如「用户喜欢喝手冲咖啡」）
 * @param {string} [clause] 该候选所在的原句（可选，用于问句判定）
 * @returns {boolean}
 */
function looksLikeFact(text, clause) {
  const t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!t) return false;
  if (t.length < MIN_LEN || t.length > MAX_LEN) return false;
  if (/[?？]\s*$/.test(t)) return false;
  // 「…吗/呢/么/吧」结尾：问句或语气词，不能当事实
  if (/(吗|呢|么|吧)\s*$/.test(t)) return false;
  if (GREETING_RE.test(t)) return false;
  if (/\bX\b/.test(t)) return false; // 模板没填上的占位
  // 纯标点/纯数字/无实义
  const content = t.replace(/[\s\p{P}\p{S}]/gu, '');
  if (content.length < 4) return false;
  // 值和标签之间只剩空壳
  const tail = t.replace(/^用户(的名字是|的身份是|希望被叫做|喜欢|不喜欢|讨厌|习惯|一般|偏好|最爱|爱|通常|平时|经常|在做|在用|用的是|记住：)/, '').trim();
  if (EMPTY_SHELL_RE.test(tail)) return false;
  // 原句是问句 → 即使候选文本形式像陈述也丢掉（「我喜欢什么？」→「用户喜欢什么」）
  if (clause) {
    const c = String(clause).trim();
    if (/[?？]\s*$/.test(c)) return false;
    if (/(\?|？)/.test(c) && /(什么|怎么|为什么|哪|多少|是否|能不能|可不可以)/.test(c)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 文本工具
// ---------------------------------------------------------------------------

const SENTENCE_DELIM = /[。！？!?；;\n]/;

/** 取 idx 所在的整句（按句末标点切） */
function clauseAround(text, idx) {
  let start = Math.max(0, idx);
  while (start > 0 && !SENTENCE_DELIM.test(text[start - 1])) start--;
  let end = Math.min(text.length, idx);
  while (end < text.length && !SENTENCE_DELIM.test(text[end])) end++;
  return text.slice(start, end).trim();
}

/** 取 idx 之前的半句（同一句内，从左到右），用于判断主语 */
function prefixSinceSentence(text, idx) {
  let start = idx;
  while (start > 0 && !SENTENCE_DELIM.test(text[start - 1])) start--;
  return text.slice(start, idx);
}

/** 把抽到的值清理成可存文本：去首尾标点、去掉吞掉的后半句、限制长度 */
function cleanValue(raw) {
  let v = String(raw == null ? '' : raw);
  // 被下一句的引号/逗号吞掉的部分切掉（注意：ASCII 句点常出现在 Node.js / a@b.com 里，只在「句点+空格」处断开）
  v = v.split(/[，,。；;：:！!？?\n]/)[0];
  v = v.split(/\.\s+/)[0];
  v = v.replace(/^[\s、~～\-—]+/, '');
  v = v.replace(/[\s、~～\-—]+$/, '');
  // 句尾语气/连接词
  v = v.replace(/(就行了?|就好|就可以|可以了|吧|啊|呀|呢|哦|嗯|啦|哈)+$/g, '');
  v = v.trim();
  if (v.length > MAX_VALUE_LEN) v = v.slice(0, MAX_VALUE_LEN);
  return v.trim();
}

/** 身份句里不许出现的谓词开头（「我是来问个问题的」不是身份） */
const IDENTITY_BAD_START =
  /^(来|在|想|要|说|问|看|觉|不|没|很|太|挺|真|确|刚|正|准|试|先|再|还|也|都|就|只|随|好|喜|讨|厌|习|偏|常|经|平|总|从|已|马|可|能|应|需|比|有|点|恐|大|约|于|让|被|把|给|对|向|做|搞|干|写|听|读|学|用|叫)/;

/** 量词前缀（「我是一个程序员」→「程序员」） */
const QUANTIFIER_PREFIX = /^(?:一个|一名|一位|一种|一位|个|名|位|只|条|家|支)/;

/** 领域标签（很轻量的一层，仅用于给记忆打 tag，方便按主题过滤） */
const TOPIC_TAGS = [
  { re: /咖啡|拿铁|美式|手冲|茶|奶茶|饮料|豆浆|果汁/, tag: '饮品' },
  { re: /前端|后端|全栈|算法|数据库|服务端|客户端|架构|运维/, tag: '技术方向' },
  { re: /node|react|vue|python|java|typescript|javascript|rust|go\b|sql/i, tag: '技术栈' },
  { re: /猫|狗|宠物|仓鼠|鱼缸/, tag: '宠物' },
  { re: /跑步|健身|游泳|骑行|瑜伽|爬山|运动/, tag: '运动' },
];

function topicTags(value) {
  const out = [];
  for (const { re, tag } of TOPIC_TAGS) if (re.test(value)) out.push(tag);
  return out;
}

function asciiTags(value) {
  const out = [];
  const re = /[A-Za-z][A-Za-z0-9._+#-]{1,}/g;
  let m;
  while ((m = re.exec(value)) !== null) {
    const w = m[0].toLowerCase();
    if (w.length <= 20 && !out.includes(w)) out.push(w);
    if (out.length >= 3) break;
  }
  return out;
}

function uniqTags(...groups) {
  const out = [];
  for (const g of groups) {
    for (const t of g || []) {
      const v = String(t || '').trim();
      if (v && !out.includes(v)) out.push(v);
    }
  }
  return out.slice(0, 8);
}

// ---------------------------------------------------------------------------
// 候选收集
// ---------------------------------------------------------------------------

/**
 * @typedef {{ text: string, kind: string, importance: number, tags: string[] }} MemoryCandidate
 */

/**
 * 从用户文本里抽记忆候选。
 *
 * @param {{ userText?: string, assistantText?: string }} [input]
 * @returns {MemoryCandidate[]}
 */
function extractMemories(input) {
  const { userText } = input || {};
  const text = String(userText == null ? '' : userText).replace(/\r\n?/g, '\n').trim();
  if (!text) return [];

  /** @type {MemoryCandidate[]} */
  const candidates = [];
  /** @type {Map<string, MemoryCandidate>} 同文本去重（保留 importance 高的） */
  const byText = new Map();

  /**
   * @param {MemoryCandidate & { clause?: string }} cand
   */
  function add(cand) {
    const t = String(cand.text || '').replace(/\s+/g, ' ').trim();
    if (!t) return;
    if (!looksLikeFact(t, cand.clause)) return;
    const prev = byText.get(t);
    if (prev) {
      if (cand.importance > prev.importance) byText.set(t, { ...cand, text: t });
      return;
    }
    byText.set(t, { text: t, kind: cand.kind, importance: cand.importance, tags: uniqTags(cand.tags) });
  }

  // ---- 1. 身份 / 称呼 -------------------------------------------------------
  // 「我叫X」「我的名字是X」
  {
    const re = /(?:我的名字(?:叫|是)|我叫)\s*([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9·_\- ]{0,15})/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const v = cleanValue(m[1]).replace(QUANTIFIER_PREFIX, '').trim();
      if (!v || v.length > 12) continue;
      if (/^(什么|啥|谁|你|您|他|她)/.test(v)) continue;
      add({
        text: `用户的名字是${v}`,
        kind: MEM_KIND.PROFILE,
        importance: 0.9,
        tags: uniqTags(['身份', '称呼'], asciiTags(v)),
        clause: clauseAround(text, m.index),
      });
    }
  }

  // 「我是X」：必须是整句结尾或紧跟标点，避免「我是说…」
  {
    const re = /(?:^|[，,。.；;！!？?\s])(?:我|本人)是\s*([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9·_\- ]{0,20})(?=[，,。.；;！!？?\s]|$)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      let v = cleanValue(m[1]).replace(QUANTIFIER_PREFIX, '').trim();
      if (!v || v.length > 16) continue;
      if (IDENTITY_BAD_START.test(v)) continue;
      if (/^(你|您|他|她|它|谁)/.test(v)) continue;
      // 「我是做前端的」这类交给下面的职业规则，不当作身份名
      add({
        text: `用户的身份是${v}`,
        kind: MEM_KIND.PROFILE,
        importance: 0.85,
        tags: uniqTags(['身份'], topicTags(v), asciiTags(v)),
        clause: clauseAround(text, m.index),
      });
    }
  }

  // 「叫我X」/「别叫我X」
  {
    const re = /(别|不要|请|就|可以|以后)?\s*叫我\s*([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9·_\- ]{0,12})/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const isNegative = /^(别|不要)$/.test(m[1] || '');
      const v = cleanValue(m[2]).replace(QUANTIFIER_PREFIX, '').trim();
      if (!v || v.length > 12) continue;
      if (/^(什么|啥|谁)/.test(v)) continue;
      if (isNegative) {
        add({
          text: `用户不喜欢被叫做${v}`,
          kind: MEM_KIND.FACT,
          importance: 0.7,
          tags: ['偏好', '称呼'],
          clause: clauseAround(text, m.index),
        });
      } else {
        add({
          text: `用户希望被叫做${v}`,
          kind: MEM_KIND.PROFILE,
          importance: 0.85,
          tags: ['身份', '称呼'],
          clause: clauseAround(text, m.index),
        });
      }
    }
  }

  // ---- 2. 偏好 -------------------------------------------------------------
  {
    const re =
      /(?:我|本人)\s*(不喜欢|最喜欢|喜欢|讨厌|习惯|偏好|最爱|爱|通常|平时|经常|一般)([^，,。；;：:！!？?\n]{2,40})/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const verb = m[1];
      const v = cleanValue(m[2]);
      if (!v || v.length < 2) continue;
      if (/^你/.test(v)) continue; // 「我喜欢你」不是偏好
      if (EMPTY_SHELL_RE.test(v)) continue;
      const neg = /^(不|讨厌)/.test(verb);
      const factText = `用户${verb}${v}`;
      add({
        text: factText,
        kind: MEM_KIND.FACT,
        importance: neg ? 0.72 : 0.7,
        tags: uniqTags(['偏好'], topicTags(v), asciiTags(v)),
        clause: clauseAround(text, m.index),
      });
    }
  }

  // 同句主语是「我」时，逗号后省略主语也算：「我叫小李，喜欢喝拿铁」。前文没有「我」就一律不认，避免误抽。
  {
    const re = /(?:^|[，,；;、])\s*(不喜欢|最喜欢|喜欢|讨厌|习惯|偏好|最爱|通常|平时|经常|一般)([^，,。；;：:！!？?\n]{2,40})/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (!/(?:我|本人)/.test(prefixSinceSentence(text, m.index))) continue;
      const verb = m[1];
      const v = cleanValue(m[2]);
      if (!v || v.length < 2) continue;
      if (/^你/.test(v)) continue; // 「我喜欢你」不是偏好
      const neg = /^(不|讨厌)/.test(verb);
      add({
        text: `用户${verb}${v}`,
        kind: MEM_KIND.FACT,
        importance: neg ? 0.72 : 0.68,
        tags: uniqTags(['偏好'], topicTags(v), asciiTags(v)),
        clause: clauseAround(text, m.index),
      });
    }
  }

  // ---- 3. 事实 / 项目 -----------------------------------------------------
  // 「我在做X」「我在写X」
  {
    const re = /(?:我|本人)\s*在\s*(做|搞|写|开发|负责)([^，,。；;：:！!？?\n]{2,40})/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const v = cleanValue(m[2]);
      if (!v || v.length < 2) continue;
      add({
        text: `用户在做${v}`,
        kind: MEM_KIND.FACT,
        importance: 0.68,
        tags: uniqTags(['项目', '事实'], topicTags(v), asciiTags(v)),
        clause: clauseAround(text, m.index),
      });
    }
  }

  // 「我用的是X」「我在用X」
  {
    const re = /(?:我|本人)\s*(?:用的是|在用|使用的?是)\s*([^，,。；;：:！!？?\n]{1,40})/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const v = cleanValue(m[1]);
      if (!v || v.length < 1) continue;
      add({
        text: `用户用的是${v}`,
        kind: MEM_KIND.FACT,
        importance: 0.66,
        tags: uniqTags(['事实', '工具'], topicTags(v), asciiTags(v)),
        clause: clauseAround(text, m.index),
      });
    }
  }

  // 「我的X是Y」
  {
    const BAD_KEYS = /^(问题|疑问|想法|感觉|意思|观点|建议|意见|看法|理解|猜测|计划|打算|需求|担心|顾虑)$/;
    const re = /(?:我|本人)的\s*([\u4e00-\u9fa5A-Za-z0-9_\- ]{1,12}?)\s*是\s*([^，,。；;：:！!？?\n]{1,40})/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const k = cleanValue(m[1]);
      const v = cleanValue(m[2]);
      if (!k || !v) continue;
      if (BAD_KEYS.test(k)) continue;
      const isName = /^(名字|姓名|称呼|昵称)$/.test(k);
      add({
        text: isName ? `用户的名字是${v}` : `用户的${k}是${v}`,
        kind: isName ? MEM_KIND.PROFILE : MEM_KIND.FACT,
        importance: isName ? 0.9 : 0.65,
        tags: isName ? uniqTags(['身份', '称呼']) : uniqTags(['事实'], topicTags(v), asciiTags(v)),
        clause: clauseAround(text, m.index),
      });
    }
  }

  // ---- 4. 显式记忆（最高优先级） ------------------------------------------
  {
    // (?!了)：「我记住了他说的话」是过去时陈述，不是指令
    const re = /(?:请|帮我|麻烦|以后|一定要|千万)?\s*(?:记住|记一下|记下来|别忘了)(?!了)[：:,，、\s]*(?:要|请|一定要)?\s*([^。！？!?\n]{2,120})/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      let v = cleanValue(m[1]).replace(/^(了|吧|啊|呀|呢|哦)+/, '').trim();
      if (!v) continue;
      if (EMPTY_SHELL_RE.test(v)) continue;
      add({
        text: `用户记住：${v}`,
        kind: MEM_KIND.NOTE,
        importance: 0.95,
        tags: uniqTags(['记忆', '显式'], topicTags(v), asciiTags(v)),
        clause: clauseAround(text, m.index),
      });
    }
  }

  return Array.from(byText.values())
    .sort((a, b) => b.importance - a.importance || b.text.length - a.text.length)
    .slice(0, MAX_ITEMS);
}

module.exports = {
  extractMemories,
  looksLikeFact,
  // 供自检脚本/调试使用
  MIN_LEN,
  MAX_LEN,
  MAX_ITEMS,
};
