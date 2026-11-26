#!/usr/bin/env node
/**
 * 作者：yb-zhai · 仓库：https://github.com/yb-zhai/agent-memory
 * nebula-workbuddy-mcp —— 记忆星云（NebulaMemory）的 WorkBuddy 版 MCP Server。
 *
 * 和通用版 nebula-memory-mcp 的区别只有三处，引擎完全相同：
 *   1. 默认数据目录落在 ~/.workbuddy/nebula-memory，记忆跟着 WorkBuddy 走；
 *   2. 工具描述按 WorkBuddy Agent 的中文语境重写，强调「先 recall 再动手」；
 *   3. 多了两件 WorkBuddy 专属的事：
 *        import_workbuddy —— 把 WorkBuddy 自带的 memory.md 和本地会话 transcript 导入记忆库；
 *        workbuddy_info   —— 报告探测到的 WorkBuddy 路径、会话数、导入水位。
 *
 * 零依赖：手写 stdio + JSON-RPC 2.0，不引 @modelcontextprotocol/sdk。
 *
 * 用法（~/.workbuddy/mcp.json）：
 *   {
 *     "mcpServers": {
 *       "nebula-memory": {
 *         "command": "node",
 *         "args": ["<repo>\\mcp-server.mjs"],
 *         "env": { "NEBULA_DATA_DIR": "C:\\Users\\<you>\\.workbuddy\\nebula-memory" }
 *       }
 *     }
 *   }
 *
 * 命令行辅助：
 *   node mcp-server.mjs import [--days 90] [--max 50] [--force] [--dry-run]
 *   node mcp-server.mjs info
 *   node mcp-server.mjs compact
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { workbuddyHome, probe, DAY_MS } from './workbuddy.mjs'
import { importWorkBuddy, importStatus } from './importer.mjs'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const { NebulaMemory } = require(path.join(__dirname, 'memory', 'store.cjs'))

const VERSION = '1.0.1'
const SERVER_INFO = { name: 'nebula-workbuddy-mcp', version: VERSION }

// ── 配置 ────────────────────────────────────────────────────────────────
// 默认放在 WorkBuddy 自己的目录下，卸载 WorkBuddy 或备份 profile 时一起走。
const DATA_DIR = path.resolve(
  process.env.NEBULA_DATA_DIR ||
  process.env.MEMORY_NEBULA_DATA_DIR ||
  path.join(workbuddyHome(), 'nebula-memory')
)

// 协议版本：客户端请求的版本在支持列表里就照抄回去（WorkBuddy / Claude / Cursor 版本不一）。
const SUPPORTED_PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18']
const DEFAULT_PROTOCOL = '2024-11-05'

// ── 多库（namespace）支持 ────────────────────────────────────────────────
const NS_ROOT = path.join(DATA_DIR, '__ns__')
const memCache = new Map() // namespace -> NebulaMemory

function normalizeNamespace(ns) {
  if (ns == null) return null
  const s = String(ns).trim()
  if (!s) return null
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(s)) throw new Error(`invalid namespace: ${s}`)
  return s
}

async function getMemory(ns) {
  if (ns == null) return null
  if (!memCache.has(ns)) {
    const m = new NebulaMemory({ dir: path.join(NS_ROOT, ns), log: () => {} })
    await m.init()
    memCache.set(ns, m)
  }
  return memCache.get(ns)
}

// ── stdio 行缓冲读写（MCP stdio transport：每行一个 JSON-RPC 消息） ──────
function readStdinLines(onLine) {
  let buf = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buf += chunk
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '')
      buf = buf.slice(idx + 1)
      if (line.trim()) onLine(line)
    }
  })
  process.stdin.on('end', () => { if (buf.trim()) onLine(buf) })
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function ok(id, result) { send({ jsonrpc: '2.0', id, result }) }
function fail(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }) }

// ── 工具定义 ─────────────────────────────────────────────────────────────
const NS_PROP = {
  type: 'string',
  description: '记忆库分区（可选）。不填=默认库；填了用独立子库（如项目名），各库互不干扰。仅字母数字、_、-，≤64 字符。',
}

const TOOLS = [
  {
    name: 'recall',
    description:
      '检索与当前任务相关的历史记忆（跨 WorkBuddy 会话）。**动手前先调一次**：用户提到「上次」「之前那个」「我的偏好」时尤其必须调，不要凭空假设。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要检索的内容，用用户的原话或关键实体' },
        limit: { type: 'number', description: '最多返回条数，默认 6（上限 50）' },
        kind: { type: 'string', enum: ['episode', 'fact', 'note', 'profile'], description: '只检索某类记忆（可选）' },
        tag: { type: 'string', description: '只检索带此标签的记忆（如 workbuddy / profile）' },
        namespace: NS_PROP,
      },
      required: ['query'],
    },
  },
  {
    name: 'remember',
    description:
      '写一条长期记忆。用户透露偏好、身份、项目约定、踩过的坑、或明确说「记住」时调用。importance=1 表示永久置顶（永不受时间衰减），用于称呼、路径、密钥指针这类不能忘的事。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要记住的内容，一句完整的话，不要只写关键词' },
        kind: { type: 'string', enum: ['episode', 'fact', 'note', 'profile'], description: 'episode=发生过的事（默认），fact=稳定事实，profile=用户画像，note=随手记' },
        importance: { type: 'number', minimum: 0, maximum: 1, description: '重要性 0~1，1.0=永久置顶' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签，便于按 tag 过滤' },
        namespace: NS_PROP,
      },
      required: ['text'],
    },
  },
  {
    name: 'recall_context',
    description: '把检索结果整理成可直接塞进上下文的紧凑记忆块（带时间与重要性标注）。适合在系统提示或开场时一次性注入，比 recall 更省 token。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要检索的内容' },
        limit: { type: 'number', description: '最多几条，默认 8' },
        maxChars: { type: 'number', description: '记忆块字符上限，默认 800' },
        namespace: NS_PROP,
      },
      required: ['query'],
    },
  },
  {
    name: 'stats',
    description: '查看记忆库统计（节点数、边数、各种类分布、磁盘占用）。',
    inputSchema: { type: 'object', properties: { namespace: NS_PROP } },
  },
  {
    name: 'forget',
    description: '按 id 删除一条记忆（用户说「忘掉这个」或记忆明显过期时用）。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '记忆 id（recall 结果里带）' }, namespace: NS_PROP },
      required: ['id'],
    },
  },
  {
    name: 'compact',
    description: '手动压缩记忆库文件（清理追加历史、减小磁盘、加快下次启动）。不丢数据。',
    inputSchema: { type: 'object', properties: { namespace: NS_PROP } },
  },
  {
    name: 'import_workbuddy',
    description:
      '把 WorkBuddy 本机的历史搬进记忆库：会话标题、用户原话、助手收尾回答，以及 WorkBuddy 自带的 memory.md 条目。一个会话迁移过 workspace 会有多份 transcript（时间区间不重叠），会全部导入并由引擎去重合并。已导入过的文件按 size/mtime 跳过，重复调用安全。',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: '只导最近 N 天有活动的会话，默认 90；0=不限（导入全部历史）' },
        maxSessions: { type: 'number', description: '单次最多处理多少个 transcript 文件，默认 50' },
        force: { type: 'boolean', description: '忽略导入水位，全部重扫（仍会按内容去重）' },
        dryRun: { type: 'boolean', description: '只统计不写入，用来看会导入多少' },
        namespace: NS_PROP,
      },
    },
  },
  {
    name: 'workbuddy_info',
    description: '探测 WorkBuddy 安装与数据位置（主目录、数据库、memory.md、transcript 数量）以及本插件的导入水位和记忆库位置。',
    inputSchema: { type: 'object', properties: {} },
  },
]

// ── 工具执行 ─────────────────────────────────────────────────────────────
// defaultMem：默认单库实例；args.namespace 传了就切到对应子库。
async function callTool(name, args = {}, defaultMem) {
  const ns = normalizeNamespace(args.namespace)
  const mem = ns == null ? defaultMem : await getMemory(ns)

  switch (name) {
    case 'remember': {
      const input = { text: String(args.text || ''), source: 'workbuddy' }
      if (args.kind) input.kind = args.kind
      if (args.importance != null) input.importance = Number(args.importance)
      if (Array.isArray(args.tags)) input.tags = args.tags.map(String)
      const r = await mem.remember(input)
      return text(`${JSON.stringify({ id: r.id, deduped: r.deduped })}`)
    }

    case 'recall': {
      const query = String(args.query || '')
      const limit = clampLimit(args.limit, 6)
      const hits = await mem.recall(query, {
        limit,
        kinds: args.kind ? [args.kind] : undefined,
        tag: args.tag ? String(args.tag) : undefined,
      })
      if (!hits.length) return text('（记忆库里没有相关记忆）')
      return text(hits.map((h, i) => `${i + 1}. [${h.kind}] ${h.text}（相关度 ${h.score}，${ageLabel(h.ts)}，id ${h.id}）`).join('\n'))
    }

    case 'recall_context': {
      const query = String(args.query || '')
      const limit = clampLimit(args.limit, 8)
      const hits = await mem.recall(query, { limit })
      if (!hits.length) return text('（记忆库里没有相关记忆）')
      const block = mem.renderContext(hits, {
        maxChars: Math.max(200, Math.min(2000, Number(args.maxChars) || 800)),
        header: '【记忆 · 来自历史会话】',
      })
      return text(block || '（没有可压缩进上下文的有价值记忆）')
    }

    case 'stats': {
      const s = await mem.stats()
      return text(JSON.stringify(s, null, 2))
    }

    case 'forget': {
      const r = await mem.forget(String(args.id || ''))
      return text(JSON.stringify(r))
    }

    case 'compact': {
      const r = await mem.compact()
      return text(JSON.stringify({
        ok: r.ok,
        durationMs: r.durationMs,
        nodeLines: `${r.before.nodeLines} -> ${r.after.nodeLines}`,
        nodesFileMB: `${r.before.nodesMB} -> ${r.after.nodesMB}`,
      }))
    }

    case 'import_workbuddy': {
      const summary = await importWorkBuddy(mem, {
        days: args.days == null ? 90 : Number(args.days),
        maxSessions: args.maxSessions == null ? 50 : Number(args.maxSessions),
        force: args.force === true,
        dryRun: args.dryRun === true,
      })
      return text(renderImportSummary(summary))
    }

    case 'workbuddy_info': {
      const p = probe()
      const st = await mem.stats()
      return text(JSON.stringify({
        workbuddy: p,
        memory: { dir: mem.dir, nodes: st.nodes, edges: st.edges, bytes: st.bytes },
        importState: importStatus(mem),
      }, null, 2))
    }

    default:
      throw new Error(`unknown tool: ${name}`)
  }
}

function text(body) {
  return { content: [{ type: 'text', text: String(body) }] }
}

function clampLimit(v, fallback) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.max(1, Math.min(50, Math.floor(n)))
}

function ageLabel(ts) {
  const ms = Date.now() - Number(ts || Date.now())
  if (!Number.isFinite(ms) || ms < 0) return '刚刚'
  const d = Math.floor(ms / DAY_MS)
  if (d === 0) return '今天'
  if (d === 1) return '1 天前'
  if (d < 30) return `${d} 天前`
  if (d < 365) return `${Math.floor(d / 30)} 个月前`
  return `${Math.floor(d / 365)} 年前`
}

function renderImportSummary(s) {
  const lines = [
    `WorkBuddy 数据目录：${s.home}`,
    s.dryRun ? '模式：试算（未写入）' : '模式：已写入',
    `扫描窗口：${s.windowDays > 0 ? '最近 ' + s.windowDays + ' 天' : '全部'}`,
    `会话文件：看到 ${s.transcriptsSeen} 份（${s.sessionsSeen} 个会话），处理 ${s.transcriptsImported}，按水位跳过 ${s.transcriptsSkipped}`,
    `写入：标题 ${s.titles} 条，消息 ${s.messages} 条（助手结论保留 ${s.assistantKept} 条、丢弃 ${s.assistantDropped} 条），memory.md ${s.memoryEntries} 条，会话内连边 ${s.edges} 条`,
    `引擎去重命中：${s.deduped} 条`,
  ]
  if (s.errors.length) lines.push(`⚠ 错误 ${s.errors.length} 条：${s.errors.slice(0, 3).join('; ')}`)
  if (s.stateFile) lines.push(`导入水位：${s.stateFile}`)
  return lines.join('\n')
}

// ── 命令行子命令 ─────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { out._.push(a); continue }
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next == null || next.startsWith('--')) out[key] = true
    else { out[key] = next; i++ }
  }
  return out
}

async function runCli(argv) {
  const cmd = argv[0]
  const args = parseArgs(argv.slice(1))
  const mem = new NebulaMemory({ dir: args.dir ? path.resolve(String(args.dir)) : DATA_DIR, log: () => {} })
  await mem.init()

  if (cmd === 'info') {
    const p = probe()
    const st = await mem.stats()
    console.log(JSON.stringify({ workbuddy: p, memory: { dir: mem.dir, nodes: st.nodes, edges: st.edges }, importState: importStatus(mem) }, null, 2))
  } else if (cmd === 'import') {
    const summary = await importWorkBuddy(mem, {
      days: args.days == null ? 90 : Number(args.days),
      maxSessions: args.max == null ? 50 : Number(args.max),
      force: args.force === true,
      dryRun: args['dry-run'] === true,
    })
    console.log(renderImportSummary(summary))
    const st = await mem.stats()
    console.log(`记忆库：${mem.dir} → 节点 ${st.nodes}，边 ${st.edges}`)
  } else if (cmd === 'compact') {
    const r = await mem.compact()
    console.log(JSON.stringify({ ok: r.ok, durationMs: r.durationMs, before: r.before, after: r.after }, null, 2))
  } else {
    console.error('用法: node mcp-server.mjs [import|info|compact] [--days N] [--max N] [--force] [--dry-run] [--dir PATH]')
    await mem.close()
    process.exit(2)
  }
  await mem.close()
}

// ── MCP 主流程 ───────────────────────────────────────────────────────────
async function main() {
  if (process.argv[2] && !process.argv[2].startsWith('-')) {
    return runCli(process.argv.slice(2))
  }

  const defaultMem = new NebulaMemory({ dir: DATA_DIR, log: () => {} })
  await defaultMem.init()

  readStdinLines(async (line) => {
    let msg
    try { msg = JSON.parse(line) } catch { return } // 忽略无法解析的行
    const { id, method, params } = msg
    if (id == null) return // 通知（无 id）不回复

    try {
      switch (method) {
        case 'initialize': {
          const requested = params && params.protocolVersion
          const version = SUPPORTED_PROTOCOLS.includes(requested) ? requested : DEFAULT_PROTOCOL
          ok(id, {
            protocolVersion: version,
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
          })
          break
        }
        case 'tools/list':
          ok(id, { tools: TOOLS })
          break
        case 'tools/call': {
          const { name, arguments: args } = params || {}
          const result = await callTool(name, args || {}, defaultMem)
          ok(id, result)
          break
        }
        case 'ping':
          ok(id, {})
          break
        default:
          fail(id, -32601, `method not found: ${method}`)
      }
    } catch (e) {
      fail(id, -32603, e.message || String(e))
    }
  })
}

main().catch((e) => { console.error(e); process.exit(1) })
