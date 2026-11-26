# WorkBuddy 开放平台连接器提交材料

按官方文档 <https://open.workbuddy.cn/docs/connector> 的 MCP + Skill 规范准备。
本地校验：`node check.mjs`（已注入故障验证过校验器能抓错）。

## 包结构

```
connector-submission/
├── connector-meta.json          # 元信息（source 全局唯一，无认证省略 auth_mode）
├── mcp.json                     # 提交用：开发机绝对路径版
├── mcp-npx.json                 # npm 发布后替换 mcp.json 用（npx + runtime 托管）
├── icon.svg                     # 市场图标，64×64，透明背景
├── skills/
│   └── nebula-workbuddy-memory-skill/
│       └── SKILL.md             # 8 个工具的使用说明
└── check.mjs                    # 本地校验脚本（不上传）
```

## 提交前必须做的两件事

### 1. mcp.json 用哪一份 —— ✅ 已决定：npx 版

| 文件 | 场景 | 审核友好度 |
|---|---|---|
| `mcp.json` | **已是 npx 版**（2026-11-26 切换完成） | ✅ 可直接提交 |
| `mcp-npx.json` | 备份参考，内容与当前 `mcp.json` 相同 | — |

**npm 已发布**：`nebula-workbuddy-mcp@1.0.1`（2026-11-26）。`mcp.json` 已用 npx 版覆盖、
`_comment` 已删，`node check.mjs` 全部通过。本地源码版的旧配置备份为
`mcp.json.bak-localpath-20261126-190223`，**仅留档，不要提交**。

> 首次发布会短暂出现 `0.0.0-stage` 占位版本（npm 对新包名的处理产物），已用
> `npm deprecate` 标记。它不影响 `npx -y nebula-workbuddy-mcp` —— `dist-tags.latest` 始终指向最新版。

### 2. `source` 唯一性

`connector-meta.json` 的 `source` 当前为 `nebula-workbuddy-memory`（kebab-case）。
官方要求**全局唯一**。提交前在开放平台搜一下是否已被占用；若占用，改成如
`nebula-memory-workbuddy`，并同步改 `mcp.json` 的 server key + `check.mjs` 的比对。

## 提交流程（需本人操作）

1. 登录 <https://open.workbuddy.cn> → 注册并入驻 → 完成**个人认证**（大陆身份证，官方入驻文档确认个人可发布连接器）。
2. 创建业务类型「连接器」→ 按上述结构上传 4 个文件（不含 `check.mjs` / `mcp-npx.json`）。
3. 选分类、服务类目、头像（可用 `icon.svg`）。
4. 提交审核，官方口径约 7 个工作日；审核通过后点发布上架。

## 注意事项（来自官方文档）

- `mcpServers` 只能配置一个 Server，系统取第一个 —— 已满足。
- stdio 用 `command` + `args`，`type` 可省略；我们显式写了 `stdio`。
- `env` 用 `${VAR}` 引用用户变量；我们用了 `${HOME}`，WorkBuddy 会在连接时替换。
- 不得硬编码 Token / 密钥 —— 本连接器纯本地无认证，天然满足。
- 我们是无认证服务，按官方规范**省略 `auth_mode`**（不是 `server-side`/`token`）。
- 所有 JSON 必须是**无 BOM 的 UTF-8**；用 PowerShell 改文件后用 `node check.mjs` 复查
  （`Set-Content -Encoding UTF8` 会加 BOM，会导致解析失败——已实测踩过）。
