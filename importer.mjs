/**
 * 作者：yb-zhai · 仓库：https://github.com/yb-zhai/nebula-workbuddy
 * WorkBuddy → 记忆星云 导入器。
 *
 * 只读 WorkBuddy 的数据，不写它任何文件；写进记忆库的是：
 *   - 会话标题（fact，重要度高，作为「这件事干过」的索引）
 *   - 用户原话（episode，去掉系统信封）
 *   - 助手收尾回答（episode，低权重，只作线索）
 *   - WorkBuddy 内置 memory.md 的记忆条目（profile，永久置顶）
 *
 * 另有一套 LLM 抽取流程（_bench/llm-full/）：把每个会话的结论抽成 1–3 条
 * fact 叠加进库，覆盖助手长文里「存在但召回不到」的事实。权重见 DISTILLED_IMPORTANCE。
 *
 * 导入单位是 **transcript 文件**，不是 sessionId：同一个会话迁移 workspace 后
 * 会在两个项目目录下各留一份、时间区间不重叠，两份都要导，靠引擎去重合并。
 * 但「最后 N 条助手结论」是**按会话**算的（跨文件合并后取时间最后 N 条），
 * 否则同一会话的两份文件会各留 N 条，等于翻倍。
 *
 * 幂等靠两层：状态文件记每个 transcript 的 size/mtime；引擎自身按相似度去重。
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  workbuddyHome,
  workbuddyPaths,
  listSessions,
  readTranscriptMessages,
  readMemoryProfile,
  truncateByChars,
  DAY_MS,
} from './workbuddy.mjs'

const STATE_FILE = '.workbuddy-import.json'
const STATE_VERSION = 2

/**
 * 入库权重：用户原话是「意图」，助手回答只是「结论线索」，后者要明显压一档。
 * 0.35 时助手消息仍能挤进召回前几名（实测占 top5 的 21%），降到 0.18 后让位给用户原话；
 * 再降到 0.10 会掉到 minScore 以下（等于删数据），0.18 是平衡点。
 */
const USER_IMPORTANCE = 0.55
const ASSISTANT_IMPORTANCE = 0.18

/**
 * LLM 抽取结论的入库权重（importance）。
 * 实测：0.85 时助手占比 4.2%、招牌查询（UAC/八字/dsh-scope）top1 都是抽取结论，
 * 但「培训记录 共享盘」会被「账号表不在共享盘」结论抢走（语义漂移）。
 * 1.0 会跳过时间衰减 → 老结论词频优势放大，出现「显卡设置」答非所问的过拟合。
 * 0.6 消除语义漂移、指标不变、招牌查询仍 top1 —— 定为最终值。
 * 抽取叠加脚本见 _bench/llm-full/finalize.mjs（写死 importance，改这里时需同步）。
 */
const DISTILLED_IMPORTANCE = 0.6

/**
 * 每个会话保留最后几条助手消息（0 = 不按位置截断）。
 * 实测设为 2 会把「已彻底卸载」「设置完成 GTX 1660 Ti」这类中段结论一起丢掉，所以默认关闭。
 */
const ASSISTANT_KEEP_PER_SESSION = 0

/**
 * 助手消息的「结论标记」过滤。
 * 位置/长度/权重三条路都试过且都失败后，改为按内容筛：只留像结论的助手消息
 * （带 ✅、明确「完成/已交付/已修复/验证通过」等交付语），其余丢掉。
 * 目的不是压数量，而是把「我先查一下」和「做好了，结果如下」区分开。
 */
const CONCLUSION_PATTERNS = [
  /✅/u,
  // 「已…修复/交付/打好/恢复」这类交付语；窗口 6 字，避免「已重新启动…修复」这种进度播报误判
  /已[^。！？\n]{0,6}(?:修复|完成|交付|打好|打包|卸载|安装|配置|生成|更新|删除|处理|解决|同步|导入|导出|生效|切换|改成|改为|恢复|就绪|可用)/u,
  // 独立完成语（「全部完成」「两件事都做完了」「打包成 1.0.17」）
  /(?:全部|都|已)?\s*(?:做完|完成|完毕)/u,
  /(?:验证通过|真机验证|实测通过|测试通过|跑通)/u,
  /(?:结论|最终方案|最终状态|结果如下|方案如下)/u,
  /(?:搞定|修好了|已经做好|做好了)/u,
  // 「这次做了三条改动」「已换好/改好了」「交付物如下」——交付性表述，但不含固定完成词
  /(?:这次|本轮|本次)\s*(?:做了|改了|调整)/u,
  /(?:改好了|换好了|已换好|调整好了)/u,
  /(?:交付物|交付完成)/u,
]

/** 判断一条助手消息是不是「结论」。 */
export function isConclusion(text) {
  const t = String(text || '').trim()
  if (!t) return false
  return CONCLUSION_PATTERNS.some((re) => re.test(t))
}

function statePath(mem) {
  return path.join(mem.dir, STATE_FILE)
}

function loadState(mem) {
  try {
    const raw = fs.readFileSync(statePath(mem), 'utf8')
    const s = JSON.parse(raw)
    if (s && Number(s.version) === STATE_VERSION && s.transcripts && typeof s.transcripts === 'object') return s
    // v1 是「按 sessionId 记水位」，与 v2 不兼容；保留 memory 水位，transcript 全部重扫（去重兜底）
    if (s && s.memory) {
      return { version: STATE_VERSION, updatedAt: s.updatedAt || '', transcripts: {}, titles: {}, memory: s.memory }
    }
  } catch {}
  return { version: STATE_VERSION, updatedAt: '', transcripts: {}, titles: {}, memory: null }
}

function saveState(mem, state) {
  state.version = STATE_VERSION
  state.updatedAt = new Date().toISOString()
  const file = statePath(mem)
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

/** 助手消息的身份：同一会话里用 ts + 正文定位（用于跨文件合并后取最后 N 条）。 */
function msgKey(m) {
  return `${m.ts}|${m.text}`
}

/**
 * @param {import('./memory/store.cjs').NebulaMemory} mem 已 init 的记忆实例
 * @param {object} [options]
 * @param {number} [options.days=90]         只导最近 N 天有活动的 transcript，0=不限
 * @param {number} [options.maxSessions=50]  单次最多处理多少个 transcript 文件
 * @param {boolean} [options.force=false]    忽略状态文件，强制重扫
 * @param {boolean} [options.dryRun=false]   只统计不写入
 * @param {string}  [options.home]           WorkBuddy 主目录（默认 ~/.workbuddy）
 */
export async function importWorkBuddy(mem, options = {}) {
  const {
    days = 90,
    maxSessions = 50,
    force = false,
    dryRun = false,
    includeTranscripts = true,
    includeMemoryFile = true,
    assistantKeepPerSession = ASSISTANT_KEEP_PER_SESSION,
    // 'all' = 全部助手收尾回答；'conclusion' = 只留带结论标记的（实测对召回排序没有净收益，默认关闭）
    assistantFilter = 'all',
  } = options
  const home = options.home || workbuddyHome()
  const summary = {
    home,
    dryRun,
    windowDays: days,
    transcriptsSeen: 0,
    transcriptsImported: 0,
    transcriptsSkipped: 0,
    sessionsSeen: 0,
    messages: 0,
    assistantKept: 0,
    assistantDropped: 0,
    edges: 0,
    titles: 0,
    memoryEntries: 0,
    deduped: 0,
    errors: [],
  }

  const state = loadState(mem)
  const cutoff = days > 0 ? Date.now() - days * DAY_MS : 0

  if (includeTranscripts) {
    let files = await listSessions(home)
    summary.transcriptsSeen = files.length
    summary.sessionsSeen = new Set(files.map((f) => f.id)).size
    if (cutoff) files = files.filter((f) => (f.lastActivityAt || f.mtimeMs || 0) >= cutoff)
    files = files.slice(0, Math.max(1, Math.floor(maxSessions)))

    // 按 sessionId 分组：「最后 N 条助手结论」是会话级概念
    const groups = new Map()
    for (const f of files) {
      if (!groups.has(f.id)) groups.set(f.id, [])
      groups.get(f.id).push(f)
    }

    const isUnchanged = (f) => {
      const prev = state.transcripts[f.transcript]
      return !!prev && prev.size === f.size && prev.mtimeMs === f.mtimeMs
    }

    const msgCache = new Map()
    const read = async (file) => {
      if (!msgCache.has(file)) msgCache.set(file, await readTranscriptMessages(file))
      return msgCache.get(file)
    }

    for (const [, group] of groups) {
      const pending = force ? group.slice() : group.filter((f) => !isUnchanged(f))
      if (!pending.length) {
        summary.transcriptsSkipped += group.length
        continue
      }

      // 会话级 keep 集合：把该会话所有文件的助手消息按时间合并后取最后 N 条
      const keep = new Set()
      if (assistantKeepPerSession > 0) {
        const all = []
        for (const f of group) {
          for (const m of await read(f.transcript)) {
            if (m.role === 'assistant') all.push({ ts: m.ts, key: msgKey(m) })
          }
        }
        all.sort((a, b) => a.ts - b.ts)
        for (const x of all.slice(-assistantKeepPerSession)) keep.add(x.key)
      }

      for (const f of pending) {
        const projectName = f.cwd ? path.basename(f.cwd) : f.project || ''
        const meta = {
          source: 'workbuddy',
          sessionId: f.id,
          project: projectName || f.project || '',
          cwd: f.cwd || '',
          model: f.model || '',
        }

        try {
          // 标题每个会话只写一次（同一会话的两份 transcript 不重复写标题）
          if (f.title && !state.titles[f.id]) {
            const label = `WorkBuddy 会话《${f.title}》${projectName ? `（项目 ${projectName}）` : ''}`
            if (dryRun) summary.titles++
            else {
              const r = await mem.remember({ text: label, kind: 'fact', importance: 0.7, tags: ['workbuddy', 'session'], meta })
              summary.titles++
              if (r.deduped) summary.deduped++
              state.titles[f.id] = new Date().toISOString()
            }
          }

          const msgs = await read(f.transcript)
          const ids = []
          for (const m of msgs) {
            if (m.role === 'assistant') {
              if (keep.size && !keep.has(msgKey(m))) {
                summary.assistantDropped++
                continue
              }
              // 结论标记过滤：只留「做好了、结果如下」这类交付性表述
              if (assistantFilter === 'conclusion' && !isConclusion(m.text)) {
                summary.assistantDropped++
                continue
              }
              summary.assistantKept++
            }
            const importance = m.role === 'user' ? USER_IMPORTANCE : ASSISTANT_IMPORTANCE
            if (dryRun) { summary.messages++; continue }
            const r = await mem.remember({
              text: m.text,
              kind: 'episode',
              importance,
              tags: ['workbuddy', m.role],
              ts: m.ts || undefined,
              meta: { ...meta, role: m.role },
            })
            ids.push(r.id)
            summary.messages++
            if (r.deduped) summary.deduped++
          }

          // 同一 transcript 内相邻消息连边：让「会话」在召回里成为可扩散的簇，
          // 而不是一堆互不相干的孤点（引擎的图扩散因子的前提就是有边）。
          if (!dryRun) {
            for (let i = 1; i < ids.length; i++) {
              if (ids[i] === ids[i - 1]) continue
              try {
                await mem.link(ids[i - 1], ids[i], 0.8, { kind: 'semantic', source: 'workbuddy.timeline' })
                summary.edges++
              } catch {
                // 连边失败不影响导入本身
              }
            }
          }

          summary.transcriptsImported++
          if (!dryRun) {
            state.transcripts[f.transcript] = {
              sessionId: f.id,
              project: f.project,
              size: f.size,
              mtimeMs: f.mtimeMs,
              messages: msgs.length,
              importedAt: new Date().toISOString(),
            }
          }
        } catch (e) {
          summary.errors.push(`${path.basename(f.transcript)}: ${e.message}`)
        }
      }
    }
  }

  if (includeMemoryFile) {
    const profile = readMemoryProfile(home)
    const key = profile.files.join('|')
    const prev = state.memory
    const unchanged = prev && prev.files === key && prev.bytes === profile.bytes
    if (!unchanged || force) {
      for (const entry of profile.entries) {
        if (dryRun) { summary.memoryEntries++; continue }
        try {
          const r = await mem.remember({
            text: truncateByChars(entry.text, 1200),
            kind: 'profile',
            importance: 0.95,
            tags: ['workbuddy', 'profile'],
            meta: { source: 'workbuddy.memory.md', uid: profile.uid },
          })
          summary.memoryEntries++
          if (r.deduped) summary.deduped++
        } catch (e) {
          summary.errors.push(`memory.md: ${e.message}`)
        }
      }
      if (!dryRun && profile.files.length) {
        state.memory = { files: key, bytes: profile.bytes, entries: profile.entries.length, importedAt: new Date().toISOString() }
      }
    }
  }

  if (!dryRun) {
    saveState(mem, state)
    summary.stateFile = statePath(mem)
  }
  return summary
}

/** workbuddy_info 用的状态摘要。 */
export function importStatus(mem) {
  const state = loadState(mem)
  const keys = Object.keys(state.transcripts || {})
  const lastImported = keys
    .map((k) => state.transcripts[k].importedAt)
    .filter(Boolean)
    .sort()
    .pop()
  return {
    stateFile: statePath(mem),
    importedTranscripts: keys.length,
    importedSessions: new Set(keys.map((k) => state.transcripts[k].sessionId).filter(Boolean)).size,
    lastImportAt: lastImported || '',
    assistantKeepPerSession: ASSISTANT_KEEP_PER_SESSION,
    memoryProfile: state.memory || null,
  }
}

export { workbuddyPaths }
