#!/usr/bin/env node
/**
 * Connector 提交材料本地校验（对照 open.workbuddy.cn/docs/connector 官方规范）。
 *   node check.mjs
 * 退出码 0=全部通过，1=有问题。不做任何网络请求、不依赖外部包。
 */
import fs from 'node:fs'
import path from 'node:path'

const DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'))
const problems = []
const ok = (name, cond, detail) => {
  console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}${detail ? ' → ' + detail : ''}`)
  if (!cond) problems.push(name)
}
const readJSON = (f) => {
  try { return JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) }
  catch (e) { problems.push(`${f} JSON 解析失败: ${e.message}`); return null }
}

// 1. 包结构
for (const f of ['connector-meta.json', 'mcp.json', 'icon.svg', 'skills/nebula-workbuddy-memory-skill/SKILL.md']) {
  ok(`文件存在: ${f}`, fs.existsSync(path.join(DIR, f)))
}
if (fs.existsSync(path.join(DIR, 'mcp-npx.json'))) console.log('[INFO] mcp-npx.json 存在（npm 发布后替换用）')

// 2. connector-meta.json 必填字段
const meta = readJSON('connector-meta.json')
if (meta) {
  for (const k of ['name', 'name_en', 'description', 'description_zh', 'description_en', 'source', 'examples_zh', 'examples_en']) {
    ok(`meta.${k} 存在`, !!meta[k])
  }
  ok('meta.source kebab-case', /^[a-z0-9_-]+$/.test(meta.source || ''), meta.source)
  ok('meta.type=mcp', meta.type === 'mcp', String(meta.type))
  ok('无认证时省略 auth_mode', !('auth_mode' in meta), JSON.stringify(meta.auth_mode))
  ok('examples_zh 2~5 条', Array.isArray(meta.examples_zh) && meta.examples_zh.length >= 2 && meta.examples_zh.length <= 5, String(meta.examples_zh?.length))
  ok('examples_en 2~5 条', Array.isArray(meta.examples_en) && meta.examples_en.length >= 2 && meta.examples_en.length <= 5, String(meta.examples_en?.length))
  ok('description_zh 20~100 字', (meta.description_zh || '').length >= 20 && (meta.description_zh || '').length <= 100, String(meta.description_zh?.length))
}

// 3. mcp.json：只能一个 server；stdio 用 command；无硬编码密钥
for (const mf of ['mcp.json', 'mcp-npx.json']) {
  if (!fs.existsSync(path.join(DIR, mf))) continue
  const cfg = readJSON(mf)
  if (!cfg) continue
  const servers = cfg.mcpServers || {}
  const keys = Object.keys(servers)
  ok(`${mf} 只有一个 server`, keys.length === 1, keys.join(','))
  const s = servers[keys[0]]
  ok(`${mf} server key 与 source 一致`, keys[0] === meta?.source, `${keys[0]} vs ${meta?.source}`)
  ok(`${mf} 有 command`, !!s?.command, s?.command)
  if (mf === 'mcp-npx.json') {
    ok('npx 版声明 runtime.node', s?.runtime?.type === 'node', JSON.stringify(s?.runtime))
    ok('npx 版 args 含包名', (s?.args || []).includes('nebula-workbuddy-mcp'))
  }
  const env = JSON.stringify(s?.env || {})
  ok(`${mf} 无硬编码密钥`, !/(sk-|api[_-]?key\s*[:=]\s*["'][^$]{6,})/i.test(env), env.slice(0, 80))
}

// 4. 图标可解析（基本 SVG 检查）
const svg = fs.readFileSync(path.join(DIR, 'icon.svg'), 'utf8')
ok('icon.svg 是合法 SVG 标签', /<svg[\s>]/.test(svg) && svg.includes('</svg>'))
ok('icon.svg 有 viewBox', /viewBox=/.test(svg))
ok('icon.svg 无外部引用', !/<image|xlink:href|<script/i.test(svg))

// 5. SKILL.md frontmatter
const skill = fs.readFileSync(path.join(DIR, 'skills/nebula-workbuddy-memory-skill/SKILL.md'), 'utf8')
ok('SKILL.md 有 frontmatter', skill.startsWith('---'))
for (const k of ['name:', 'description:', 'version:', 'author:']) {
  ok(`SKILL frontmatter ${k}`, skill.split('---')[1]?.includes(k))
}
// 8 个工具都写到
const tools = ['recall', 'remember', 'recall_context', 'stats', 'forget', 'compact', 'import_workbuddy', 'workbuddy_info']
for (const t of tools) ok(`SKILL 覆盖工具 ${t}`, skill.includes(`### ${t} `))

console.log(`\n${problems.length ? `== ${problems.length} 个问题: ${problems.join(', ')} ==` : '== 全部通过 =='}`)
process.exit(problems.length ? 1 : 0)
