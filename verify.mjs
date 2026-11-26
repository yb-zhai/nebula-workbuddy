#!/usr/bin/env node
/**
 * 作者：yb-zhai · 仓库：https://github.com/yb-zhai/nebula-workbuddy
 * 端到端自检：真的把 mcp-server.mjs 当子进程拉起来，走一遍 MCP 握手和工具调用。
 * 用临时记忆库，不碰用户的 ~/.workbuddy/nebula-memory。
 *
 *   node verify.mjs
 *
 * 退出码 0 = 全通过；1 = 有失败项（逐条打印）。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.join(os.tmpdir(), 'nebula-wb-verify-' + Date.now())
fs.mkdirSync(dataDir, { recursive: true })

const results = []
function check(name, cond, detail) {
  results.push({ name, ok: !!cond })
  console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}${detail ? ' → ' + detail : ''}`)
}

const child = spawn(process.execPath, [path.join(__dirname, 'mcp-server.mjs')], {
  env: { ...process.env, NEBULA_DATA_DIR: dataDir },
  stdio: ['pipe', 'pipe', 'pipe'],
})

let buf = ''
const pending = new Map()
let nextId = 1
const stderrLog = []

child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { console.log('[非 JSON 输出]', line.slice(0, 200)); continue }
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

function toolText(res) {
  return res?.result?.content?.[0]?.text || ''
}

try {
  // 1) 握手：请求 2025-06-18，服务端应照抄回去
  const init = await call('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'wb-verify', version: '0' },
  })
  check('initialize 返回 serverInfo', init.result?.serverInfo?.name === 'nebula-workbuddy-mcp', JSON.stringify(init.result?.serverInfo))
  check('协议版本协商', init.result?.protocolVersion === '2025-06-18', init.result?.protocolVersion)

  // 2) 工具清单
  const list = await call('tools/list', {})
  const names = (list.result?.tools || []).map((t) => t.name)
  check('tools/list 含 8 个工具', names.length === 8, names.join(','))
  for (const need of ['remember', 'recall', 'recall_context', 'stats', 'forget', 'compact', 'import_workbuddy', 'workbuddy_info']) {
    check(`工具存在: ${need}`, names.includes(need))
  }

  // 3) WorkBuddy 探测（真实目录，只读）
  const info = await call('tools/call', { name: 'workbuddy_info', arguments: {} })
  const infoObj = JSON.parse(toolText(info))
  check('探测到 WorkBuddy 主目录', infoObj.workbuddy?.exists === true, infoObj.workbuddy?.home)
  check('探测到 transcript', (infoObj.workbuddy?.transcriptCount || 0) > 0, `transcriptCount=${infoObj.workbuddy?.transcriptCount}`)

  // 4) 写入 + 召回
  const rem = await call('tools/call', {
    name: 'remember',
    arguments: { text: '自检记忆：用户偏好深色主题，工作目录在 E:\\DSHN', kind: 'profile', importance: 1 },
  })
  const remObj = JSON.parse(toolText(rem))
  check('remember 返回 id', !!remObj.id, JSON.stringify(remObj))

  const rec = await call('tools/call', { name: 'recall', arguments: { query: '用户偏好什么主题', limit: 5 } })
  check('recall 命中刚写的内容', toolText(rec).includes('深色主题'), toolText(rec).slice(0, 160))

  const ctx = await call('tools/call', { name: 'recall_context', arguments: { query: '工作目录偏好', maxChars: 400 } })
  check('recall_context 生成记忆块', toolText(ctx).includes('【记忆'), toolText(ctx).slice(0, 120))

  // 5) 导入试算（不写入）
  const dry = await call('tools/call', { name: 'import_workbuddy', arguments: { days: 90, dryRun: true } })
  const dryText = toolText(dry)
  check('import 试算可执行', dryText.includes('试算'), dryText.split('\n')[0] + ' / ' + (dryText.split('\n')[3] || ''))

  // 6) 真实导入（临时库，最多 5 个会话）
  const imp = await call('tools/call', { name: 'import_workbuddy', arguments: { days: 90, maxSessions: 5 } })
  const impText = toolText(imp)
  check('import 真实写入', impText.includes('已写入'), impText.replace(/\n/g, ' | ').slice(0, 240))

  // 7) 导入后的统计应增长
  const st = JSON.parse(toolText(await call('tools/call', { name: 'stats', arguments: {} })))
  check('记忆库节点数 > 1', st.nodes > 1, `nodes=${st.nodes}, edges=${st.edges}, bytes=${st.bytes}`)
  check('会话内已建时间线边', st.edges > 0, `edges=${st.edges}`)

  // 8) 导入的记忆能被召回（用真实会话标题里的词）
  const rec2 = await call('tools/call', { name: 'recall', arguments: { query: 'WorkBuddy 会话', limit: 5 } })
  check('导入内容可召回', toolText(rec2).includes('WorkBuddy 会话'), toolText(rec2).slice(0, 200))

  // 9) 错误路径：未知方法应回 -32601，而不是静默
  const bad = await call('no/such/method', {})
  check('未知方法返回 -32601', bad.error?.code === -32601, JSON.stringify(bad.error))

  // 10) 未知工具应报错，不崩
  const badTool = await call('tools/call', { name: 'nope', arguments: {} })
  check('未知工具报错', !!badTool.error, JSON.stringify(badTool.error))
} catch (e) {
  check('整体流程', false, e.message)
} finally {
  child.stdin.end()
  child.kill()
  const failed = results.filter((r) => !r.ok)
  if (failed.length && stderrLog.length) console.log('\n[stderr]', stderrLog.join('').slice(0, 1200))
  console.log(`\n== ${results.length - failed.length}/${results.length} 通过，临时库 ${dataDir} ==`)
  process.exit(failed.length ? 1 : 0)
}
