# 命名决定（2026-11-26 确认）

| 层面 | 名字 | 状态 |
|---|---|---|
| npm 包名 | `nebula-workbuddy-mcp` | ✅ **已发布 1.0.0 / 1.0.1 / 1.0.2** |
| GitHub 仓库 | `yb-zhai/nebula-workbuddy` | ✅ 已建并推送（仓库名比包名少 `-mcp`，为了以后能扩内容） |
| WorkBuddy server id（面板显示名） | `nebula-memory` | ✅ 已配置、已信任、已缓存，不再改 |
| 本地项目目录 | `E:\DSHN\build\nebula-workbuddy-mcp` | ✅ 保持 |
| 通用版包名（另一条线） | `nebula-memory-mcp` v1.2.1 | 不动，独立版本线 |

## 为什么是这个组合

- **不撞名**：查过 npm registry 的候选：
  - `agent-memory` → 已被他人占用（2025 年空壳包，248 字节）
  - `agent-memory-mcp` → 已被他人占用（别人的 TypeScript 项目，功能相似但完全不同）
  - `nebula-workbuddy-mcp` → 404 可注册，**已选并发布**
  - `nebula-memory-workbuddy` → 404 可注册，但和现有目录名不一致，弃用
- **不折腾**：server id `nebula-memory` 已经在 WorkBuddy 面板信任、缓存了 8 个工具，
  改名要重新走「信任 → 握手 → 缓存」全流程，没有实质收益。
- **成体系**：`nebula-memory-mcp`（通用版）+ `nebula-workbuddy-mcp`（WorkBuddy 版）一眼可辨。

## 包名与仓库名不一致，是故意的

包名 `nebula-workbuddy-mcp` **发布后不可更改**（npm registry 数据不可变），
所以它必须保持现在的样子。

仓库则不然 —— 叫 `nebula-workbuddy`（少一段 `-mcp`）范围更宽，
以后加 CLI、Skill、连接器素材都能放进同一个仓库，不会被 `-mcp` 锁死。
两者的对应关系由 `package.json` 的 `repository` 字段建立，不依赖名字相同。

## 命名空间相互独立（曾担心「重名」）

三处名字看起来像但不冲突，因为它们分属不同命名空间：

| 名字 | 出现在哪 | 用户是否直接看到 |
|---|---|---|
| `nebula-workbuddy-mcp` | npm 包名 | 只在 `npx` 命令里 |
| `nebula-workbuddy` | GitHub 仓库 | 点 npm 页面「Repository」时 |
| `nebula-memory` | 本地 `~/.workbuddy/mcp.json` 的 server key | ✅ 就是 **WorkBuddy 面板上显示的那个名字** |
| `nebula-workbuddy-memory` | 连接器的 `source` id | 连接器详情页 |

**所以「改 npm 包名」不会改变 WorkBuddy 面板上显示的名字** ——
想让面板换名字，改的是 `mcp.json` 的 key。

## 已完成的发布动作（2026-11-26）

1. `npm publish` 1.0.0 → 首次发布，registry 短暂出现 `0.0.0-stage` 占位（已 `npm deprecate` 标记）
2. 版本号四处同步 → 1.0.1（`package.json` / `mcp-server.mjs` 的 `VERSION` / `connector-meta.json` / 本目录 README）
3. `repository` 修正为 `git+https://github.com/yb-zhai/nebula-workbuddy.git`
4. `npm publish` 1.0.1 → `dist-tags.latest = 1.0.1`
5. 握手实测 `serverInfo = {"name":"nebula-workbuddy-mcp","version":"1.0.1"}`

## 相关记忆

- Hindsight 页 kp-65e40bf135c44745983ff30e10497606（记忆星云 + Hindsight 整合）
- WorkBuddy MCP 页 kp-5fb9a92f239a4f8fa00c9673e3b8f2bc
