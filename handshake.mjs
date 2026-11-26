#!/usr/bin/env node
/**
 * 作者：yb-zhai · 仓库：https://github.com/yb-zhai/agent-memory
 * 按「WorkBuddy 实际会用的配置」验证接入：
 * 直接读 ~/.workbuddy/mcp.json 里那一条，用它的 command / args / env 把服务拉起来，
 * 走真实 MCP 握手 + tools/list + stats + 若干条 recall。
 *
 *   node handshake.mjs
 *   node handshake.mjs --id nebula-memory --query "画面乱码" --query "模拟器 渲染"
 *   node handshake.mjs --config D:\tmp\mcp.json --protocol 2024-11-05
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function parseArgs(argv) {
  const out = { query: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (key === 'query') { if (next && !next.startsWith('--')) { out.query.push(next); i++ } continue }
    if (next == null || next.startsWith('--')) out[key] = true
    else { out[key] = next; i++ }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const HOME = process.env.WORKBUDDY_HOME || path.join(os.homedir(), '.workbuddy')
const configPath = path.resolve(args.config || path.join(HOME, 'mcp.json'))
const serverId = String(args.id || 'nebula-memory')
const protocol = String(args.protocol || '2025-06-18')
const queries = args.query.length ? args.query : ['WorkBuddy 会话', '用户偏好', '最近在做什么']

if (!fs.existsSync(configPath)) {
  console.error(`✗ 找不到 ${configPath}，先跑 node install.mjs`)
  process.exit(2)
}
const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''))
const entry = cfg.mcpServers?.[serverId]
if (!entry) {
  console.error(`✗ ${configPath} 里没有 "${serverId}"，先跑 node install.mjs`)
  process.exit(2)
}

console.log(`配置：${configPath}`)
console.log(`server：${serverId}`)
console.log(`command：${entry.command}`)
console.log(`args：${(entry.args || []).join(' ')}`)
console.log(`env：${JSON.stringify(entry.env || {})}`)
console.log('')

const child = spawn(entry.command, entry.args || [], {
  env: { ...process.env, ...(entry.env || {}) },
  stdio: ['pipe', 'pipe', 'pipe'],
})

let buf = ''
const pending = new Map()
let nextId = 1
const stderrLog = []
const results = []

function check(name, cond, detail) {
  results.push({ name, ok: !!cond })
  console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}${detail ? ' → ' + detail : ''}`)
}

child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    const r = pending.get(msg.id)
    if (r) { pending.delete(msg.id); r(msg) }
  }
})
child.stderr.setEncoding('utf8')
child.stderr.on('data', (d) => stderrLog.push(d))

function call(method, params, timeoutMs = 120000) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout: ${method}`)), timeoutMs)
    pending.set(id, (m) => { clearTimeout(t); resolve(m) })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}

const textOf = (res) => res?.result?.content?.[0]?.text || ''

try {
  const init = await call('initialize', { protocolVersion: protocol, capabilities: {}, clientInfo: { name: 'wb-handshake', version: '0' } })
  check('握手成功（serverInfo）', !!init.result?.serverInfo, JSON.stringify(init.result?.serverInfo))
  check('协议版本', init.result?.protocolVersion === protocol, init.result?.protocolVersion)

  const list = await call('tools/list', {})
  const names = (list.result?.tools || []).map((t) => t.name)
  check('tools/list', names.length > 0, names.join(','))

  const stats = JSON.parse(textOf(await call('tools/call', { name: 'stats', arguments: {} })))
  check('记忆库可读', stats.nodes > 0, `dir=${stats.dir}, nodes=${stats.nodes}, edges=${stats.edges}, bytes=${stats.bytes}`)

  for (const q of queries) {
    const res = await call('tools/call', { name: 'recall', arguments: { query: q, limit: 3 } })
    const body = textOf(res)
    check(`recall「${q}」`, body && !body.includes('没有相关记忆'), body.split('\n').slice(0, 3).join(' ⏎ ').slice(0, 300))
  }
} catch (e) {
  check('整体流程', false, e.message)
} finally {
  child.stdin.end()
  child.kill()
  const failed = results.filter((r) => !r.ok)
  if (failed.length && stderrLog.length) console.log('\n[stderr]', stderrLog.join('').slice(0, 1500))
  console.log(`\n== ${results.length - failed.length}/${results.length} 通过 ==`)
  process.exit(failed.length ? 1 : 0)
}
