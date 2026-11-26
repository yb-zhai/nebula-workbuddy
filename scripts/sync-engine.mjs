#!/usr/bin/env node
/**
 * 作者：yb-zhai · 仓库：https://github.com/yb-zhai/nebula-workbuddy
 *
 * 引擎同步：本项目的 memory/ 与 shared/ 是 nebula-memory-mcp 的副本。
 * 引擎（store.cjs 等）只在那条线上改，改完跑这个脚本同步过来，避免两套实现漂移。
 *
 *   node scripts/sync-engine.mjs            # 复制
 *   node scripts/sync-engine.mjs --check    # 只比对 sha256，不写文件
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const here = path.resolve(__dirname, '..')
const source = path.resolve(here, '..', 'nebula-memory-mcp')
const checkOnly = process.argv.includes('--check')

const dirs = ['memory', 'shared']
const report = []

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

for (const dir of dirs) {
  const srcDir = path.join(source, dir)
  if (!fs.existsSync(srcDir)) {
    console.error(`✗ 源目录不存在: ${srcDir}`)
    process.exit(1)
  }
  const dstDir = path.join(here, dir)
  fs.mkdirSync(dstDir, { recursive: true })
  for (const name of fs.readdirSync(srcDir)) {
    const src = path.join(srcDir, name)
    if (!fs.statSync(src).isFile()) continue
    const dst = path.join(dstDir, name)
    const same = fs.existsSync(dst) && sha256(src) === sha256(dst)
    report.push({ file: `${dir}/${name}`, same })
    if (!same && !checkOnly) fs.copyFileSync(src, dst)
  }
}

const drift = report.filter((r) => !r.same)
for (const r of report) console.log(`${r.same ? '=' : checkOnly ? '≠' : '→'} ${r.file}`)
console.log('')
if (checkOnly) {
  console.log(drift.length ? `有 ${drift.length} 个文件与引擎源不一致` : '与引擎源完全一致')
  process.exit(drift.length ? 1 : 0)
}
console.log(drift.length ? `已同步 ${drift.length} 个文件` : '无需同步')
