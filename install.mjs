#!/usr/bin/env node
/**
 * 作者：yb-zhai · 仓库：https://github.com/yb-zhai/nebula-workbuddy
 * 把本 MCP Server 写进 WorkBuddy 的 ~/.workbuddy/mcp.json。
 *
 *   node install.mjs                       # 安装 / 更新
 *   node install.mjs --uninstall           # 移除（备份保留）
 *   node install.mjs --data-dir D:\mem     # 自定义记忆库目录
 *   node install.mjs --id wb-nebula        # 自定义 server id（默认 nebula-memory）
 *
 * 只动 mcp.json 里自己的那一条，其余 server 原样保留；改前先备份。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const HOME = process.env.WORKBUDDY_HOME || path.join(os.homedir(), '.workbuddy')
const CONFIG = path.join(HOME, 'mcp.json')

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next == null || next.startsWith('--')) out[key] = true
    else { out[key] = next; i++ }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const SERVER_ID = String(args.id || 'nebula-memory')
const DATA_DIR = path.resolve(args['data-dir'] || process.env.NEBULA_DATA_DIR || path.join(HOME, 'nebula-memory'))
const ENTRY = {
  command: process.execPath,
  args: [path.join(__dirname, 'mcp-server.mjs')],
  env: { NEBULA_DATA_DIR: DATA_DIR },
}

function readConfig() {
  if (!fs.existsSync(CONFIG)) return { mcpServers: {} }
  const raw = fs.readFileSync(CONFIG, 'utf8').replace(/^\uFEFF/, '')
  if (!raw.trim()) return { mcpServers: {} }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    console.error(`✗ ${CONFIG} 不是合法 JSON（${e.message}）。为避免覆盖你的配置，本次不修改，请先手动修好。`)
    process.exit(1)
  }
  if (!parsed || typeof parsed !== 'object') parsed = {}
  if (!parsed.mcpServers || typeof parsed.mcpServers !== 'object') parsed.mcpServers = {}
  return parsed
}

function backup(file) {
  if (!fs.existsSync(file)) return null
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')
  const dest = `${file}.bak-${stamp}`
  fs.copyFileSync(file, dest)
  return dest
}

function writeConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true })
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
}

const cfg = readConfig()
const bak = backup(CONFIG)

if (args.uninstall) {
  if (cfg.mcpServers[SERVER_ID]) {
    delete cfg.mcpServers[SERVER_ID]
    writeConfig(cfg)
    console.log(`✓ 已从 ${CONFIG} 移除 "${SERVER_ID}"${bak ? `（备份 ${path.basename(bak)}）` : ''}`)
  } else {
    console.log(`· ${CONFIG} 里没有 "${SERVER_ID}"，无需移除`)
  }
  process.exit(0)
}

cfg.mcpServers[SERVER_ID] = ENTRY
writeConfig(cfg)

console.log('✓ 已写入 WorkBuddy MCP 配置')
console.log(`  配置文件 : ${CONFIG}${bak ? `（原文件备份为 ${path.basename(bak)}）` : ''}`)
console.log(`  server id: ${SERVER_ID}`)
console.log(`  command  : ${ENTRY.command}`)
console.log(`  args     : ${ENTRY.args.join(' ')}`)
console.log(`  记忆库   : ${DATA_DIR}`)
console.log('')
console.log('接下来：')
console.log('  1. 重启 WorkBuddy（或在其「插件 → MCP 服务器」里重新加载）')
console.log(`  2. 确认 ${SERVER_ID} 状态为绿色，且工具列表里能看到 recall / remember / import_workbuddy`)
console.log('  3. 首次使用先在对话里让它「导入我最近 90 天的 WorkBuddy 记忆」')
