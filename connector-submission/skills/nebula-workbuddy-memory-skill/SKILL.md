---
name: nebula-workbuddy-memory-skill
description: 记忆星云 WorkBuddy 版的使用说明：何时检索跨会话记忆、如何导入 WorkBuddy 历史、各工具的参数与边界。
version: 1.0.0
author: yb-zhai
---

# 记忆星云 · WorkBuddy 本地记忆

零依赖、纯本地的跨会话记忆。所有数据存在用户本机 `~/.workbuddy/nebula-memory`，
不联网、不调 LLM、不花 Token。用户说「上次」「之前那个」「我的偏好」「我记得」时，
优先用 `recall` 检索，不要凭空假设。

## 可用工具

### recall — 检索历史记忆

动手前先调一次，尤其是用户提到过去的偏好、结论、事件时。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| query | string | 是 | 检索内容，用用户原话或关键实体 |
| limit | number | 否 | 最多条数，默认 6（上限 50） |
| kind | enum | 否 | episode / fact / note / profile，只看某类 |
| tag | string | 否 | 按标签过滤，如 workbuddy / profile |
| namespace | string | 否 | 记忆库分区，字母数字 `_` `-`，≤64 字；不填=默认库 |

返回每条含 id、相关度、时间、正文。用户说「忘掉这个」时，用返回里的 id 调 `forget`。

### remember — 写入长期记忆

用户透露身份、偏好、项目约定、踩过的坑，或明确说「记住」时调用。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| text | string | 是 | 一句完整的话，不要只写关键词 |
| kind | enum | 否 | episode（默认）/ fact / note / profile |
| importance | number | 否 | 0~1；1.0=永久置顶，不受时间衰减 |
| tags | string[] | 否 | 标签，便于按 tag 过滤 |
| namespace | string | 否 | 同上 |

### recall_context — 生成可注入上下文的记忆块

把召回结果压成带时间标注的紧凑块，适合开场一次性注入，比逐条 `recall` 省 token。
参数：`query`（必填）、`limit`（默认 8）、`maxChars`（默认 800）、`namespace`。

### stats — 查看记忆库统计

无必填参数。返回节点数、边数、各类分布、磁盘占用。支持 `namespace`。

### forget — 删除一条记忆

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| id | string | 是 | `recall` 返回的记忆 id |
| namespace | string | 否 | 同上 |

### compact — 压缩记忆库文件

无必填参数。清理追加历史、减小磁盘、加快下次启动，不丢数据。支持 `namespace`。

### import_workbuddy — 导入 WorkBuddy 历史

首次接入时建议调用一次。只读 WorkBuddy 自己的数据（会话 transcript、`memory.md`），
不改 WorkBuddy 任何文件。已导入过的会话按文件大小/时间跳过，重复调用安全。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| days | number | 否 | 只导最近 N 天，默认 90；0=全部历史 |
| maxSessions | number | 否 | 单次最多处理多少个 transcript 文件，默认 50 |
| force | boolean | 否 | 忽略水位全部重扫（仍按内容去重） |
| dryRun | boolean | 否 | 只统计不写入，先看会导多少 |
| namespace | string | 否 | 同上 |

### workbuddy_info — 探测环境

无必填参数。返回 WorkBuddy 路径、发现的 transcript 数、导入水位、记忆库位置。

## 使用建议

1. **先检索再回答**：涉及用户过去说过的偏好、做过的事、得出的结论时，先 `recall`。
2. **导入历史**：用户说「导入我的历史」时用 `import_workbuddy`；可先 `dryRun: true` 看规模。
3. **多库隔离**：按项目用 `namespace` 分开，避免不同项目的记忆互相污染。
4. **永久事实**：用户的称呼、固定路径等用 `importance: 1.0`，避免被时间衰减。
5. **不要编造**：`recall` 返回「没有相关记忆」时如实说明，不要虚构用户说过的偏好。

## 边界与限制

- 纯本地运行：不需要账号、API Key、网络；断网照常工作。
- 导入只读：不改 WorkBuddy 的 `workbuddy.db`、`projects/*.jsonl`、`memory.md`。
- 一个会话可能有两份 transcript（workspace 从 C 盘迁到 D 盘），导入会都处理并按内容去重合并。
- 助手的收尾回答以低权重入库，仅作结论线索；用户原话权重更高。
- 记忆库默认在 `~/.workbuddy/nebula-memory`，卸载 WorkBuddy 时可一并清理或备份。
