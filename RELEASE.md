# 发布说明

> 本文件记录 npm 发布流程、已知坑与 token 策略变化。**发版前先读这一页。**

## 一、发布流程

```powershell
cd E:\DSHN\build\nebula-workbuddy-mcp

# 1. 自检（必做）
node verify.mjs                 # 期望 23/23 通过
# 语法检查
Get-ChildItem -Recurse -Filter *.mjs | ForEach-Object { node --check $_.FullName }

# 2. 升版本（不要手动改，避免格式漂移）
cmd /c "npm.cmd version patch --no-git-tag-version"

# 3. 确认要打进包的文件（防止把 docs/、临时文件带进去）
cmd /c "npm.cmd pack --dry-run"

# 4. 发布
cmd /c "npm.cmd publish"

# 5. 等 staged 窗口结束（见第二节），再核对
# 6. 提交版本改动
git add package.json && git commit -m "chore(release): x.y.z"
git push origin master
```

## 二、⚠️ 发布后的「staged 窗口」——版本会暂时 404

**这是 npm 的新行为，不是发布失败。**

publish 输出 `+ nebula-workbuddy-mcp@x.y.z`、退出码 0 之后：

- `https://registry.npmjs.org/<包>/<版本>` 仍然 **404**，`dist-tags.latest` 也还没变；
- 这是 npm 把版本放进**暂存区**做校验，**7～17 分钟内自动转公开**，无需人工批准；
- 本次实测（2026-11-26）：1.0.3 大约 **3 分钟**后公开。

### 怎么正确等待

- **不要重复 publish**。同版本再发会报
  `409 Conflict - Cannot publish over previously staged version "x.y.z"`，
  且该版本号会被占用，只能换号。
- **不要信 `npm view`**：它走本地缓存，会一直显示旧版本。直接查 registry API：

```powershell
Invoke-RestMethod 'https://registry.npmjs.org/nebula-workbuddy-mcp' |
  Select-Object -ExpandProperty 'dist-tags'
```

### latest 可能滞后

版本公开后 `latest` 仍可能指向旧版，手动指过去：

```powershell
cmd /c "npm.cmd dist-tag add nebula-workbuddy-mcp@x.y.z latest"
```

### 误发版本无法立即删除

发错的版本 `npm unpublish <包>@<版本> --force` 往往被 **403** 拒绝（新版本有冷却期）。
处理办法：让它留着但**不指向 latest**（`npm install` / `npx` 只认 latest，用户不受影响），
或者等冷却期过后再删。

## 三、⚠️ 2FA-bypass token 将于 2027-01 停止直接发布

当前 `.npmrc` 里用的是**绕过 2FA 的 granular token**（`_authToken=npm_...`）。
npm 的策略时间线：

| 时间 | 变化 |
|---|---|
| 2026-07 | 开始弃用 bypass-2FA token 的账户/包管理权限（改 token、改维护者、改 trusted publisher 必须交互式 2FA） |
| 2026-09-18 | 新增 **stage-only** 权限的 token：只能 `npm stage publish`，不能直接 `npm publish` |
| **2027-01（目标）** | **bypass-2FA token 彻底失去直接发布能力**，发布面缩到「读取私有包 + 暂存发布」 |

也就是说：**2027 年 1 月以后，`npm publish` 用现在这个 token 会失败**。届时两条路：

1. **升级 npm 11+，走 staged publishing**
   ```powershell
   npm install -g npm@11
   cmd /c "npm.cmd stage publish"     # 上传到暂存区
   cmd /c "npm.cmd stage list"        # 查看待批准的版本
   cmd /c "npm.cmd stage approve <包>@<版本>"   # 交互式 2FA 批准后上线
   ```
2. **换一个不开 Bypass 2FA 的 granular token**，发布时提供 OTP（`npm publish --otp=<6位码>`）。

> 参考：
> [npm stage 命令文档](https://docs.npmjs.com/cli/v11/commands/npm-stage) ·
> [GitHub Changelog：npm 安装时安全与 GAT bypass-2fa 弃用](https://github.blog/changelog/2026-07-08-npm-install-time-security-and-gat-bypass2fa-deprecation/) ·
> [stage-only token 说明](https://safeguard.sh/resources/blog/npm-stage-only-tokens-dist-tag-oidc)

## 四、版本历史

| 版本 | 内容 | 备注 |
|---|---|---|
| 1.0.0 | 首个 WorkBuddy 专用 MCP | |
| 1.0.1 | npx 接入文档 | |
| 1.0.2 | 接入改为 npx 零安装优先 | |
| **1.0.3** | **npm 页面门面更新**：封面图、15 页评测链接、完整许可章节、官方市场门槛说明 | 纯文档改动，功能同 1.0.2 |
| 1.0.4 | 误发（排查 staged 时测试用的重复版本） | 与 1.0.3 内容完全相同；非 latest，未删除（403） |

**注意**：1.0.4 已在 npm 上占号，下次发版从 **1.0.5** 起。

## 五、发布前自检清单

- [ ] `node verify.mjs` 全过
- [ ] `npm pack --dry-run` 里没有 `docs/`、`connector-submission/`、`*.bak-*`
- [ ] README 里的图片/附件链接可访问（npm 页面不打包 `docs/`，必须用绝对 URL）
- [ ] `package.json` 的 `version`、`repository`、`author` 正确
- [ ] 提交信息用 Conventional Commits（`chore(release): x.y.z`）
