/**
 * DSH-memory-nebula — 记忆引擎 ESM 入口。
 *
 * 桥接层：NebulaMemory 是 CommonJS（require），本插件的 server.js 是 ESM（import）。
 * 这里用一个薄包装把 CJS 模块"转"成 ESM 可 import 的形式，零改动底层 store.js。
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const { NebulaMemory } = require('./store.cjs')

export { NebulaMemory }
export default NebulaMemory
