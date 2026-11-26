# 命名决定（2026-11-26 确认，不再变动）

| 层面 | 最终名字 | 状态 |
|---|---|---|
| npm 包名（发布用） | `nebula-workbuddy-mcp` | ✅ 已查 registry = 404，可注册，暂未发布 |
| WorkBuddy server id（面板显示名） | `nebula-memory` | ✅ 已配置、已信任、已缓存，不再改 |
| 本地项目目录 | `E:\DSHN\build\nebula-workbuddy-mcp` | ✅ 保持 |
| 通用版包名（已发布，另一条线） | `nebula-memory-mcp` v1.2.1 | 不动，独立版本线 |

## 为什么是这个组合

- **不撞名**：查过 npm registry 的三个候选：
  - `agent-memory` → 已被他人占用（2025 年空壳包，248 字节）
  - `agent-memory-mcp` → 已被他人占用（别人的 TypeScript 项目，功能相似但完全不同）
  - `nebula-workbuddy-mcp` → **404 可注册**，选它
  - `nebula-memory-workbuddy` → 404 可注册，但和现有目录名不一致，弃用
- **不折腾**：server id `nebula-memory` 已经在 WorkBuddy 面板信任、缓存了 8 个工具，
  改名要重新走「信任 → 握手 → 缓存」全流程，没有实质收益。
- **成体系**：`nebula-memory-mcp`（通用版）+ `nebula-workbuddy-mcp`（WorkBuddy 版）一眼可辨。

## 发布时需做（尚未执行）

1. `npm publish` 前再次 `curl https://registry.npmjs.org/nebula-workbuddy-mcp` 确认仍是 404
   （名字可能被他人在这期间抢注）。
2. `package.json` 的 `name` / `bin` 已是 `nebula-workbuddy-mcp`，无需改。
3. README 的 npx 用法写 `npx -y nebula-workbuddy-mcp`。
4. 发布后 `mcp.json` 可从本机绝对路径改成 `npx` 方式，便于分发。

## 相关记忆

- Hindsight 页 kp-65e40bf135c44745983ff30e10497606（记忆星云 + Hindsight 整合）
- WorkBuddy MCP 页 kp-5fb9a92f239a4f8fa00c9673e3b8f2bc
