# WorkBuddy 开放平台连接器提交材料

按官方文档 <https://open.workbuddy.cn/docs/connector> 的 MCP + Skill 规范准备。
本地校验：`node check.mjs`（已注入故障验证过校验器能抓错）。

## 包结构

```
connector-submission/
├── connector-meta.json          # 元信息（source 全局唯一，无认证省略 auth_mode）  ← 上传
├── mcp.json                     # 提交用：已是 npx 版                             ← 上传
├── icon.svg                     # 市场图标，64×64，透明背景                      ← 上传
├── skills/
│   └── nebula-workbuddy-memory-skill/
│       └── SKILL.md             # 8 个工具的使用说明                             ← 上传
├── mcp-npx.json                 # 备份参考，内容与 mcp.json 相同（不上传）
├── REVIEWER-NOTE.md             # 给审核方的 stdio 合规说明，填备注/回复用（不上传）
├── check.mjs                    # 本地校验脚本（不上传）
└── *.bak-*                      # 开发机绝对路径备份（不上传）
```

## 提交前必须做的两件事

### 1. mcp.json 用哪一份 —— ✅ 已决定：npx 版

| 文件 | 场景 | 审核友好度 |
|---|---|---|
| `mcp.json` | **已是 npx 版**（2026-11-26 切换完成） | ✅ 可直接提交 |
| `mcp-npx.json` | 备份参考，内容与当前 `mcp.json` 相同 | — |

**npm 已发布**：`nebula-workbuddy-mcp@1.0.2`（2026-11-26）。`mcp.json` 已用 npx 版覆盖、
`_comment` 已删，`node check.mjs` 全部通过。本地源码版的旧配置备份为
`mcp.json.bak-localpath-20261126-190223`，**仅留档，不要提交**。

> 首次发布会短暂出现 `0.0.0-stage` 占位版本（npm 对新包名的处理产物），已用
> `npm deprecate` 标记。它不影响 `npx -y nebula-workbuddy-mcp` —— `dist-tags.latest` 始终指向最新版。

### 2. `source` 唯一性

`connector-meta.json` 的 `source` 当前为 `nebula-workbuddy-memory`（kebab-case）。
官方要求**全局唯一**。提交前在开放平台搜一下是否已被占用；若占用，改成如
`nebula-memory-workbuddy`，并同步改 `mcp.json` 的 server key + `check.mjs` 的比对。

## 提交流程（需本人操作）

1. 登录 <https://open.workbuddy.cn> → 注册并入驻 → 完成**个人认证**（大陆身份证）。

   > ⚠️ **2026-11-26 实测更正**：原文此处写「官方入驻文档确认个人可发布连接器」，与平台实际不符。
   > 在控制台点「创建」时平台弹窗明确提示：
   >
   > `个人开发者后续无法创建/更新连接器，如需创建/更新，请进行企业认证，成为企业开发者`
   >
   > 平台自身的门槛文案（`personalConnector`）也是同一句。所以**连接器上架必须企业认证**，
   > 个人认证不够。同类受限的还有 Buddy应用 / 硬件接入 / 积分应用 / 分享功能接入；
   > 未发现限制「技能」「专家」的个人门槛文案。
   >
   > 没有营业执照时的替代路径见 README 末尾「不进市场的分发方式」。
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
## 不进市场的分发方式（无需企业认证）

连接器上架要求企业认证，但**包本身已经能用了** —— 用户手动添加 MCP 即可，
不需要任何认证。三种方式任选：

### 方式 A：WorkBuddy 界面添加（推荐，30 秒）

打开 WorkBuddy →「MCP 服务管理」→ 右上「**+ 添加 MCP**」→ 填：

```
名称：nebula-memory
命令：npx
参数：-y nebula-workbuddy-mcp
```

**不需要填任何环境变量** —— 记忆库默认落在 `~/.workbuddy/nebula-memory`
（代码里 `process.env.NEBULA_DATA_DIR || path.join(workbuddyHome(), 'nebula-memory')`）。
然后重启 WorkBuddy，在 MCP 列表里看到 `nebula-memory` 绿色、8/8 工具即成功。

### 方式 B：直接改配置文件

编辑 `~/.workbuddy/mcp.json`，加入（已有其他 server 就合并到 `mcpServers` 里）：

```json
{
  "mcpServers": {
    "nebula-memory": {
      "command": "npx",
      "args": ["-y", "nebula-workbuddy-mcp"]
    }
  }
}
```

### 方式 C：本地源码 + 安装脚本

适合要改代码或锁定版本的人：

```powershell
git clone https://github.com/yb-zhai/nebula-workbuddy.git
cd nebula-workbuddy
node install.mjs          # 写入 ~/.workbuddy/mcp.json（自动备份原文件）
node mcp-server.mjs import --days 90   # 可选：导入历史会话
node handshake.mjs --query "测试"      # 可选：验证握手与召回
```

### 分发渠道建议（不依赖官方市场）

| 渠道 | 做法 |
|---|---|
| GitHub README | 仓库已公开，写清方式 A 的两行配置即可 |
| npm 页面 | `nebula-workbuddy-mcp` 已发布，npm 页面会自动展示 README |
| 技能/专家渠道 | 平台未限制个人发布「技能」「专家」，可考虑用它们做「入口」引导用户手动装 MCP |

> 注意：官方市场仍是获得「一键安装」体验的唯一途径，但它要求企业认证。
> 若不打算做企业认证，就以上面的手动方式分发，功能完全一致。
