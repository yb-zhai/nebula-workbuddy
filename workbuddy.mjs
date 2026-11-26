/**
 * 作者：yb-zhai · 仓库：https://github.com/yb-zhai/agent-memory
 * WorkBuddy 数据桥 —— 只读，不改 WorkBuddy 任何文件。
 *
 * 这一层负责把 WorkBuddy 自己的本地数据翻译成记忆条目：
 *   1. ~/.workbuddy/memory/<uid>_memory.md   WorkBuddy 内置的「用户记忆」文本块
 *   2. ~/.workbuddy/workbuddy.db             sessions 表（标题 / cwd / 模型 / 时间）
 *   3. ~/.workbuddy/projects/<slug>/<id>.jsonl  会话 transcript（user / assistant 消息）
 *
 * 设计约束：WorkBuddy 可能在运行时持有 WAL 锁，所以数据库只以 readOnly 打开，
 * 打不开就降级为「只扫 transcript 目录」，绝不因为读不到标题就让整个导入失败。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import readline from 'node:readline'

const DAY_MS = 86400000

export function workbuddyHome() {
  return process.env.WORKBUDDY_HOME || path.join(os.homedir(), '.workbuddy')
}

export function workbuddyPaths(home = workbuddyHome()) {
  return {
    home,
    db: path.join(home, 'workbuddy.db'),
    memoryDir: path.join(home, 'memory'),
    projectsDir: path.join(home, 'projects'),
    mcpConfig: path.join(home, 'mcp.json'),
    sessionsDir: path.join(home, 'sessions'),
  }
}

/** 按字符（不是 UTF-16 码元）截断，避免把中文或 emoji 切一半。 */
export function truncateByChars(text, max) {
  const chars = Array.from(String(text || ''))
  if (chars.length <= max) return chars.join('')
  return chars.slice(0, max).join('') + '…'
}

/**
 * 去掉 WorkBuddy 每条用户消息外面包的上下文信封。
 *
 * WorkBuddy 的用户消息不是纯文本：前面塞了 system-reminder、项目上下文、身份文件，
 * 还会把「上一轮工具调用 / 上一条消息」回显进来。这些都不能进记忆库——
 * 它们既不是用户的意图，又是跨会话重复率最高的噪声。
 * 真正的用户输入通常包在 <user_query> 里；有就只取它，没有才退回「删噪声后剩下的文本」。
 */
const NOISE_TAGS = [
  'system-reminder', 'memory_and_skills_reminder', 'user_info', 'identity_context',
  'product_identity', 'project_context', 'project_layout', 'connector-status',
  'current_time', 'craft_mode', 'previous_tool_call', 'previous_assistant_message',
  'previous_user_message', 'conversation_history_summary', 'cb_summary',
  'task-notification', 'tool-result', 'tool_use', 'tool_result', 'tool-use-id',
  'task-id', 'image_local_path', 'summary', 'result', 'omitted', 'status',
  'div', 'span', 'button', 'script', 'analysis', 'option',
]

export function stripUserEnvelope(text) {
  let s = String(text || '')

  // 1) 有 <user_query> 就只取它——这是 WorkBuddy 标记真实用户输入的位置
  const queries = [...s.matchAll(/<user_query[^>]*>([\s\S]*?)<\/user_query>/gi)].map((m) => m[1])
  if (queries.length) s = queries.join('\n')

  // 2) 删掉已知的上下文块（跑两遍，处理简单嵌套）
  for (let pass = 0; pass < 2; pass++) {
    for (const tag of NOISE_TAGS) {
      s = s.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), '')
      s = s.replace(new RegExp(`<${tag}\\b[^>]*\\/>`, 'gi'), '')
    }
  }

  // 3) 去掉残留的成对/单标签，保留正文
  s = s.replace(/<\/?[a-z][a-z0-9_-]*(?:\s[^>]*)?\/?>/gi, '')
  s = s.replace(/^\s*Note:\s*Prefer using absolute paths[\s\S]*$/gim, '')
  s = s.replace(/[ \t]+\n/g, '\n')
  s = s.replace(/\n{3,}/g, '\n\n')
  return s.trim()
}

async function openDb(file) {
  // node:sqlite 自 Node 22.5 起内置（实验特性）；老版本 Node 上这里会抛错 → 由调用方降级。
  const { DatabaseSync } = await import('node:sqlite')
  return new DatabaseSync(file, { readOnly: true })
}

/**
 * 列出 WorkBuddy 的会话 transcript（一个文件一条记录）。
 *
 * 注意：同一个 sessionId 可能在两个项目目录下各有一份 transcript——
 * 迁移 workspace（C:\Users\...\WorkBuddy → D:\WorkBuddy\Workspaces）之后，
 * 旧文件冻结在搬迁时刻、新文件从搬迁时刻继续写，两份的时间区间不重叠。
 * 所以这里**以文件为单位**返回，由导入器合并，不能按 sessionId 去重。
 *
 * @returns {Promise<Array<{id:string,title:string,cwd:string,status:string,model:string,
 *   createdAt:number,updatedAt:number,lastActivityAt:number,project:string,
 *   transcript:string,size:number,mtimeMs:number}>>}
 */
export async function listSessions(home = workbuddyHome()) {
  const p = workbuddyPaths(home)
  /** @type {Map<string, any>} sessionId → 数据库里的元数据 */
  const meta = new Map()

  if (fs.existsSync(p.db)) {
    let db = null
    try {
      db = await openDb(p.db)
      const rows = db
        .prepare(
          `select id, cwd, title, custom_title, status, model, created_at, updated_at, last_activity_at
             from sessions where deleted_at is null
            order by coalesce(last_activity_at, updated_at) desc`
        )
        .all()
      for (const r of rows) {
        meta.set(r.id, {
          title: r.custom_title || r.title || '',
          cwd: r.cwd || '',
          status: r.status || '',
          model: r.model || '',
          createdAt: Number(r.created_at) || 0,
          updatedAt: Number(r.updated_at) || 0,
          lastActivityAt: Number(r.last_activity_at) || Number(r.updated_at) || 0,
        })
      }
    } catch {
      // 数据库被锁 / node:sqlite 不可用 → 退化为纯文件扫描（标题会缺）
    } finally {
      try { if (db) db.close() } catch {}
    }
  }

  const out = []
  if (!fs.existsSync(p.projectsDir)) return out

  let slugs = []
  try { slugs = fs.readdirSync(p.projectsDir) } catch { slugs = [] }
  for (const slug of slugs) {
    const dir = path.join(p.projectsDir, slug)
    let names = []
    try { names = fs.readdirSync(dir) } catch { continue }
    for (const name of names) {
      // 只认 <sessionId>.jsonl；排除 .file-rollback.ndjson 之类的旁路文件
      if (!name.endsWith('.jsonl') || name.endsWith('.file-rollback.ndjson')) continue
      const id = name.slice(0, -'.jsonl'.length)
      const file = path.join(dir, name)
      let st = null
      try { st = fs.statSync(file) } catch { continue }
      if (!st || st.size < 2) continue
      const m = meta.get(id) || {}
      out.push({
        id,
        title: m.title || '',
        cwd: m.cwd || '',
        status: m.status || 'unknown',
        model: m.model || '',
        createdAt: m.createdAt || Math.round(st.birthtimeMs || st.mtimeMs),
        updatedAt: m.updatedAt || Math.round(st.mtimeMs),
        lastActivityAt: m.lastActivityAt || Math.round(st.mtimeMs),
        project: slug,
        transcript: file,
        size: st.size,
        mtimeMs: Math.round(st.mtimeMs),
      })
    }
  }

  return out.sort((a, b) => (b.lastActivityAt || b.mtimeMs) - (a.lastActivityAt || a.mtimeMs))
}

/**
 * 流式读一个 transcript，抽出可入库的对话文本。
 *
 * 只保留「用户说了什么」和「助手最后交付的结论」：
 *   - 用户消息：去掉上下文信封后入库（这是意图，最值钱）；
 *   - 助手消息：如果它后面还跟着 function_call（说明只是「我现在去查一下」这类
 *     行动前导语），直接丢掉；真正的收尾回答才入库，且只留开头。
 *
 * 逐行流式解析，不把整份文件读进内存 —— 本机有 78MB / 1.6 万行的单会话 transcript。
 *
 * @returns {Promise<Array<{role:string,text:string,ts:number}>>}
 */
export async function readTranscriptMessages(file, { userChars = 1800, assistantChars = 500 } = {}) {
  const out = []
  /** @type {Array<{role:string,text:string,ts:number}>} 尚未确认是「结论」的助手消息 */
  const pending = []
  const flush = () => {
    for (const p of pending) out.push(p)
    pending.length = 0
  }

  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })

  for await (const line of rl) {
    if (!line.trim()) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (!e) continue

    // 出现工具调用 → 之前挂着的助手消息都是行动前导语，丢弃
    if (e.type === 'function_call' || e.type === 'tool_call' || e.type === 'function_call_result') {
      pending.length = 0
      continue
    }
    if (e.type !== 'message') continue

    const role = e.role
    if (role !== 'user' && role !== 'assistant') continue

    const parts = Array.isArray(e.content) ? e.content : []
    let text = ''
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue
      if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
        text += String(part.text || '') + '\n'
      }
    }
    text = text.trim()
    if (!text) continue

    if (role === 'user') {
      // 新一轮用户输入开始 → 上一轮挂着的助手消息就是该轮的收尾
      flush()
      const cleaned = stripUserEnvelope(text)
      if (cleaned.length < 2) continue
      out.push({ role, text: truncateByChars(cleaned, userChars), ts: Number(e.timestamp) || 0 })
      continue
    }

    const cleaned = text.replace(/\s+/g, ' ').trim()
    if (cleaned.length < 12) continue
    // 中断/取消这类系统回执不是「结论」，别污染记忆库
    if (/^(interrupted by user|request cancelled|请求已中断|用户已中断)/i.test(cleaned)) continue
    pending.push({ role, text: truncateByChars(cleaned, assistantChars), ts: Number(e.timestamp) || 0 })
  }

  flush() // 文件结束 → 最后挂着的那条就是收尾
  return out
}

/**
 * 读 WorkBuddy 内置的 memory profile（memory/<uid>_memory.md）。
 * 文件格式固定：`## Memory Block` 下面是正文，`<!-- RAW_JSON_START ... -->` 里是元数据。
 */
export function readMemoryProfile(home = workbuddyHome()) {
  const dir = workbuddyPaths(home).memoryDir
  const result = { files: [], uid: '', updatedAt: '', entries: [], bytes: 0 }
  if (!fs.existsSync(dir)) return result

  let names = []
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('_memory.md')) } catch { return result }
  for (const name of names) {
    const file = path.join(dir, name)
    let text = ''
    try { text = fs.readFileSync(file, 'utf8') } catch { continue }
    result.files.push(file)
    result.bytes += Buffer.byteLength(text, 'utf8')

    const jsonStart = text.indexOf('<!-- RAW_JSON_START')
    const jsonEnd = text.indexOf('RAW_JSON_END', jsonStart + 1)
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      const body = text.slice(jsonStart + '<!-- RAW_JSON_START'.length, jsonEnd).trim()
      try {
        const meta = JSON.parse(body)
        if (meta.uid) result.uid = String(meta.uid)
        if (meta.updatedAt) result.updatedAt = String(meta.updatedAt)
        if (meta.memoryBlock) result.entries.push(...splitMemoryBlock(meta.memoryBlock))
      } catch {
        // RAW_JSON 坏掉不影响下面按文本切分
      }
    }
    if (!result.entries.length) {
      const blockStart = text.indexOf('## Memory Block')
      if (blockStart >= 0) {
        const blockEnd = jsonStart > blockStart ? jsonStart : text.length
        result.entries.push(...splitMemoryBlock(text.slice(blockStart + '## Memory Block'.length, blockEnd)))
      }
    }
  }
  return result
}

function splitMemoryBlock(block) {
  const entries = []
  for (const line of String(block || '').split(/\r?\n/)) {
    const t = line.replace(/^\s*(?:[-*•]|\d+[.)、])\s*/, '').trim()
    if (t.length < 6) continue
    if (/^#{1,6}\s/.test(t)) continue
    if (/^(?:Memory Block|User Memory Profile)$/i.test(t)) continue
    entries.push({ text: truncateByChars(t, 1200) })
  }
  return entries
}

/** 目录扫描：只统计，不读内容（workbuddy_info 用）。 */
export function probe(home = workbuddyHome()) {
  const p = workbuddyPaths(home)
  const info = {
    home: p.home,
    exists: fs.existsSync(p.home),
    db: { path: p.db, exists: fs.existsSync(p.db) },
    memoryDir: { path: p.memoryDir, exists: fs.existsSync(p.memoryDir) },
    projectsDir: { path: p.projectsDir, exists: fs.existsSync(p.projectsDir) },
    mcpConfig: { path: p.mcpConfig, exists: fs.existsSync(p.mcpConfig) },
    transcriptCount: 0,
    memoryFiles: 0,
    days: 0,
  }
  if (fs.existsSync(p.projectsDir)) {
    let slugs = []
    try { slugs = fs.readdirSync(p.projectsDir) } catch {}
    for (const slug of slugs) {
      try {
        info.transcriptCount += fs
          .readdirSync(path.join(p.projectsDir, slug))
          .filter((n) => n.endsWith('.jsonl') && !n.endsWith('.file-rollback.ndjson')).length
      } catch {}
    }
  }
  if (fs.existsSync(p.memoryDir)) {
    try { info.memoryFiles = fs.readdirSync(p.memoryDir).filter((n) => n.endsWith('_memory.md')).length } catch {}
  }
  return info
}

export { DAY_MS }
