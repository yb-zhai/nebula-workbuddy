# 给审核方的说明：本连接器是「本地 stdio」MCP，无需服务端部署

> 用途：提交时填在审核备注里，或审核方提出「MCP Server 已部署、可公网访问」疑问时直接回复。
> 本文件**不随连接器包上传**（同 `check.mjs` / `mcp-npx.json`）。
---

## 审核备注（可直接粘贴，短版）

### 极简版（170 字，备注框窄时用）

```text
本连接器为本地 stdio MCP，无服务端、无需公网，用户侧零安装（npx + runtime.node 由
WorkBuddy 托管 Node）。验证：npx -y nebula-workbuddy-mcp info 应输出 JSON、退出码 0；
接入后握手返回 8 个工具。纯本地、无认证、数据不出本机。包已发布 nebula-workbuddy-mcp@1.0.2。
```

### 标准版（634 字，备注框够用时用这个）

```text
1. 形态：本地 stdio MCP（command: npx + runtime: node>=18），由 WorkBuddy 拉起子进程，
   不依赖任何公网服务。官方文档「支持的传输方式」明确把 stdio 列为「本地进程（如通过
   npx 运行）」，其 mcp.json 示例与本连接器结构一致。因此「Server 已部署、可公网访问」
   这条对 sse/streamableHttp 适用；对 stdio，等价要求是「包已发布、可被 npx 稳定拉取」，
   已满足。

2. 验证：npm view nebula-workbuddy-mcp version → 1.0.2；npx -y nebula-workbuddy-mcp info
   → 退出码 0、输出 JSON；用任意 MCP 客户端以 stdio 方式拉起，握手返回 serverInfo
   {"name":"nebula-workbuddy-mcp","version":"1.0.2"} 与 8 个工具（recall / remember /
   recall_context / stats / forget / compact / import_workbuddy / workbuddy_info）。

3. 安全与隔离：零依赖、纯本地，无 Token/密钥，无认证（按规范省略 auth_mode）；记忆数据
   写入 ~/.workbuddy/nebula-memory；Node 由 WorkBuddy 托管并隔离安装位置，不写用户全局
   npm 环境。

4. 如需更详细说明（传输形态依据原文、mcp.json 逐字段解释、常见疑问），可随时联系我补充。
```

> 下面是从头解释的完整版，供审核方追问时使用，一般不必粘贴。


## 一句话结论

本连接器是**运行在用户本机的 stdio MCP**，由 WorkBuddy 通过 `npx` 拉起，
**不存在、也不需要任何服务端 / 公网服务**。这是官方文档明确支持的接入形态。

## 官方依据

WorkBuddy 连接器文档「支持的传输方式」一节：

| 传输类型 | 说明 | 适用场景 |
|---|---|---|
| sse | Server-Sent Events，流式推送 | 远程 HTTP 服务 |
| streamableHttp | 可流式的 HTTP 响应 | 远程 HTTP 服务 |
| **stdio** | **标准输入输出** | **本地进程（如通过 npx 运行）** |

文档「编写 mcp.json」一节的官方示例，与本连接器的配置**结构完全一致**：

```json
{
  "type": "stdio",
  "command": "npx",
  "args": ["my-mcp-package"],
  "runtime": { "type": "node", "version": ">=18.0.0" },
  "npmRegistry": "https://registry.npmmirror.com"
}
```

字段说明（官方原文）：

- `*.command`（stdio 必填）：执行命令（如 **npx**、uvx、node）
- `*.runtime`（可选）：stdio 子进程运行时声明，`{ "type": "node", "version"?: string }`
- `*.npmRegistry`（可选）：npm registry 镜像（仅 `runtime.type='node'` 生效）

因此「MCP Server 已部署、可通过公网访问」这一条**适用于 sse / streamableHttp**；
对 stdio 形态，等价的要求是「**包已发布、可被 npx 稳定拉取**」，本连接器已满足。

## 本连接器的实际配置

`mcp.json`：

```json
{
  "mcpServers": {
    "nebula-workbuddy-memory": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "nebula-workbuddy-mcp"],
      "env": { "NEBULA_DATA_DIR": "${HOME}\\.workbuddy\\nebula-memory" },
      "runtime": { "type": "node", "version": ">=18.0.0" },
      "npmRegistry": "https://registry.npmmirror.com",
      "timeout": 30000
    }
  }
}
```

| 字段 | 说明 |
|---|---|
| `command: npx` + `args` | 从 npm registry 拉取并运行，**用户无需自备 Node**（由 `runtime` 托管） |
| `runtime.node >=18` | WorkBuddy 托管 Node 运行时，隔离安装目录，不污染用户全局环境 |
| `npmRegistry` | 国内镜像加速首次拉取 |
| `env.NEBULA_DATA_DIR` | 记忆库落在 `~/.workbuddy/nebula-memory`，跟随用户 profile |
| 无 `auth_mode` | 完全本地、无任何认证需求，按官方规范**省略**（不是 `server-side` / `token`） |

## 审核方如何验证（约 1 分钟）

### 1. 确认包可拉取

```powershell
npm view nebula-workbuddy-mcp version dist-tags
```

期望：`version = '1.0.2'`，`dist-tags = { latest: '1.0.2' }`

### 2. 直接拉起并检查能力（与 WorkBuddy 内部一致）

```powershell
npx -y nebula-workbuddy-mcp info
```

期望：输出合法 JSON（WorkBuddy 环境探测结果），**退出码 0**。

### 3. 标准 MCP 握手验证

**注意**：本包只有一个可执行入口 `mcp-server.mjs`（bin 名为 `nebula-workbuddy-mcp`），
它启动后即进入 **stdio MCP 服务模式**，因此**没有** `handshake` 之类的子命令
（可用子命令只有 `info` / `import` / `compact`）。

正确验证方式：把任意 MCP 客户端（WorkBuddy 自身、MCP Inspector、
Claude Desktop 等）的 stdio server 配置成：

```
command: npx
args:    ["-y", "nebula-workbuddy-mcp"]
```

客户端会自动发送 `initialize` → `tools/list`，应返回：

- `serverInfo = {"name":"nebula-workbuddy-mcp","version":"1.0.2"}`
- `protocolVersion = 2025-06-18`
- **8 个工具**：`recall` / `remember` / `recall_context` / `stats` /
  `forget` / `compact` / `import_workbuddy` / `workbuddy_info`

包内另附 `handshake.mjs`（依赖本机 `~/.workbuddy/mcp.json`），
仅用于我们开发侧自测，**不建议审核方使用**。

我们实测结果：

```
[PASS] 握手成功（serverInfo）     → {"name":"nebula-workbuddy-mcp","version":"1.0.2"}
[PASS] 协议版本                  → 2025-06-18
[PASS] tools/list                → recall, remember, recall_context, stats,
                                   forget, compact, import_workbuddy, workbuddy_info
[PASS] 记忆库可读                → nodes=927, edges=944
[PASS] recall 检索               → 返回相关历史记忆
```

## 常见疑问

**Q：为什么没有 URL / 域名 / OAuth？**
A：本连接器是纯本地记忆引擎，数据不出用户本机，没有任何外部服务可访问。
官方规范对无需认证的 MCP 明确要求**省略 `auth_mode`**，我们照此处理。

**Q：用户需要自己安装 Node 或什么软件吗？**
A：不需要。`runtime: { type: "node" }` 让 WorkBuddy 托管 Node 运行时并隔离安装目录，
用户侧零安装。

**Q：会不会写用户系统环境？**
A：不会。包安装到 WorkBuddy 托管的隔离位置，不写全局 `npm` 目录；
记忆数据只写入 `~/.workbuddy/nebula-memory`（用户自己的 profile 目录）。

**Q：数据安全/隐私如何保证？**
A：零依赖、纯本地、离线可用。无网络请求、无 API Key、无 Token、
不上传任何用户数据。记忆库就是本机的一个目录，用户可随时删除。

**Q：8 个工具都是做什么的？**
A：`recall`（检索）、`remember`（写入）、`recall_context`（生成可注入的上下文块）、
`stats`（统计）、`forget`（删除）、`compact`（压缩）、
`import_workbuddy`（导入 WorkBuddy 自身历史会话）、`workbuddy_info`（探测环境）。
用法与参数见随包的 `SKILL.md`。

## 附加信息

| 项 | 值 |
|---|---|
| npm 包 | `nebula-workbuddy-mcp@1.0.2`（公开） |
| 源码仓库 | https://github.com/yb-zhai/nebula-workbuddy |
| 许可证 | MIT |
| 依赖数量 | **0**（纯 Node 标准库） |
| 数据默认位置 | `~/.workbuddy/nebula-memory` |
