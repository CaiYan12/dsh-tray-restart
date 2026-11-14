# 第 1 步信息收集：调研结论

> 采集时间：2026-11-14
> 方法：直接读取本机 `app.asar`（裸 fd 解析，未修改任何字节）+ 克隆三个参照仓库读源码。
> 本文件只记录**实测事实**；推论单独标注。

## 一、本机 DSH 环境（全部实测）

### 1.1 版本与安装

| 项 | 值 | 来源 |
|---|---|---|
| 桌面端版本 | `0.2.2-rc.3` | asar 内 `package.json` 的 `version` |
| 包名 | `@deepseek-ai/dsh-desktop` | 同上 |
| exe | `D:\Program Files\Deepseek\DeepSeek Harness.exe`（246,341,104 B） | `ls -la` |
| asar | `D:\Program Files\Deepseek\resources\app.asar`（209,021,953 B，21,717 文件） | 同上 |
| 更新通道 | `channel: nightly`，feed `https://download.deepseek.com/dsh-desk/feeds/win-x64/` | `resources/app-update.yml` |

### 1.2 asar 头部布局（**修正了任务书的偏移**）

```
u32 @ 0  = 4            (pickle 头)
u32 @ 4  = 5669972      (header pickle 总长)
u32 @ 8  = 5669968      (header 字符串长度，含 padding)
u32 @ 12 = 5669961      (JSON 长度)      ← 不是 dataOffset 的基准
JSON     = 从 16 开始
dataOffset = 8 + u32@4 = 5669980        ← 正确算法
```

- `lib/main.js`：`offset = 201509551`，`size = 848505`，`unpacked = false`
- 绝对偏移 = `5669980 + 201509551` = **207179531**（任务书写 207179528，差 3 字节）

> 任务书 §2.1 的 `dataStart=207179528` 与实际不符。若按该值读取，会读到错位 3 字节的垃圾数据。

### 1.3 Electron fuses（`@electron/fuses` v1 wire 实测）

| Fuse | 状态 |
|---|---|
| `RunAsNode` | **ENABLED** |
| `EnableCookieEncryption` | DISABLED |
| `EnableNodeOptionsEnvironmentVariable` | ENABLED |
| `EnableNodeCliInspectArguments` | ENABLED |
| `EnableEmbeddedAsarIntegrityValidation` | **DISABLED** |
| `OnlyLoadAppFromAsar` | **DISABLED** |
| `LoadBrowserProcessSpecificV8Snapshot` | DISABLED |
| `GrantFileProtocolExtraPrivileges` | **ENABLED** |

与任务书 §2.1 一致。

### 1.4 托盘区域（实测）

- `//#region lib/types/tray.js` 起始偏移 **759609**（2026-11-14 复核更正；早前记录的 779389 是 Buffer 搜索的 off-by-one 错误，该偏移实际落在 `navigateMain` 函数体内）
- 区域结束偏移（exclusive）**760863**
- 区域长度 **1254 字节**（含末尾换行）
- `{ type: "separator" }` 在 region 内恰好 1 处，位于 region 相对偏移 927
- 区域内是 `var DesktopTray = class { constructor / relabel / dispose }`
- 原版菜单三项：`openApplication` → `{ type: "separator" }` → `quitApplication`
- **原版无重启项**（确认）

### 1.5 关键 token 计数（实测）

| token | 次数 | 任务书 |
|---|---|---|
| `quitWithoutConfirmation` | **4** | 4 ✅ |
| `app.relaunch()` | **2** | 2 ✅ |
| `restartApplication` | **10** | 10 ✅ |
| `requestTrayRestart` | 0 | — |
| `restartAfterQuit` | 0 | — |
| `dsh-tray-restart` | 0 | — |

**asar 是干净原版**，无任何旧插件残留。

### 1.6 语法完整性（**与任务书 §2.4 相反**）

```
$ node --check main-extracted.js
exitcode=0
```

- 首行：`import { createRequire } from "node:module";`
- 末行：`//#endregion\nexport {};\n`
- 848505 B / 21786 行

**本机 0.2.2-rc.3 的 `lib/main.js` 是完整合法的 ES 模块**，不是任务书描述的「首行 `\n}`、末行 `export {` 截断」。

> 任务书 §2.4 与 §2.5 描述的残缺形态，与本机实测不符。旧插件 `@hxhxh/dsh-tray-restart@0.3.1` 报 `SyntaxError: Unexpected token '}'` 的根因需要重新判定——可能是它读取偏移错误（用了 `16 + u32@12` 而非 `8 + u32@4`）导致读入错位数据，而非文件本身残缺。

### 1.7 写权限与运行时锁（实测）

| 检查 | 结果 |
|---|---|
| `accessSync(asar, W_OK)` | **通过** |
| `openSync(asar, 'r+')` | **成功**（DSH 正在运行时） |

- 任务书 §4 风险 1（运行时 EPERM）：**本机未复现**
- 任务书 §4 风险 2（Program Files 写权限）：**本机可写**

> 注意：`r+` 成功只说明能打开；实际 `writeSync` 是否被映射阻止，需在实现阶段实测。

### 1.8 asar integrity 记录

```json
{
  "algorithm": "SHA256",
  "hash": "f808749c7a1a907e1acb354e774d1cebf1d1c2561fd789d8fbee1e9c412caa00",
  "blockSize": 4194304,
  "blocks": ["f808749c7a1a907e1acb354e774d1cebf1d1c2561fd789d8fbee1e9c412caa00"]
}
```

- 整文件 1 个 block（848505 < 4 MiB）
- 但 `EnableEmbeddedAsarIntegrityValidation` 为 DISABLED，integrity 实际不参与校验
- 仍建议同步更新，避免后续工具（如 asar 校验器）报错

### 1.9 locale 文案（实测，`main.js` 内嵌 6 语言）

| 语言 | `restartApplication` | `aboutProduct` 推测 |
|---|---|---|
| en | `"Restart"` | — |
| zh | `"重启"` | — |
| ja | `"再起動"` | — |
| es | `"Reiniciar"` | — |
| fr | `"Redémarrer"` | — |
| de | `"Neustart"` | — |

- 中文下菜单文案将是 **「重启 DeepSeek Harness」**
- `messages` 通过 `this.options.locale()` 取得，`DesktopTray` 构造时传入 `locale: currentDesktopLocale`

### 1.10 退出链路（实测源码）

```js
function quitWithoutConfirmation() {
  skipQuitConfirmation = true;
  app.quit();
}

app.on("before-quit", (event) => {
  if (shellInstallerOwnsQuit) { /* 直接清理后 return */ }
  if (quitting) return;
  event.preventDefault();
  if (skipQuitConfirmation || sessionEnding) { finishQuit(); return; }
  quitConfirmation.confirm().then(...);
});
```

`finishQuit` 顺序：`quitting = true` → `shuttingDown = true` → `tray?.dispose()` → 隐藏窗口 → `backend.close()`（关 Host）→ `operationJournal?.drain(500)` → `app.quit()`

**`finishQuit` 内没有 `app.relaunch()`**。所以 `app.relaunch(); quitWithoutConfirmation();` 的顺序可行：`relaunch()` 只登记下次启动参数，不立即退出。

### 1.11 profile 装载情况

- `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 中**没有**任何 tray 相关包
- `node_modules/@hxhxh` 与 `node_modules/dsh-tray-restart` **均不存在**
- 但 `cordis.patch.yml` 第 1023-1024 行仍有残留：
  ```yaml
  - id: dsh-tray-restart
    disabled: true
  ```
  这是顶层裸条目（覆盖式），目标不存在时被静默忽略，无副作用，但属清理残留。
- `@local/dsh-overload-preset` 的 link 模式：`node_modules/@local/dsh-overload-preset` → `..\..\..\..\..\Documents\deepseek-harness\default-workspace\overload-preset`
- 其 `package.json` 关键字段：`"name": "@local/dsh-overload-preset"`, `"private": true`, `"type": "module"`, `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`

## 二、参照实现对比

### 2.1 maqian1632/dsh-tray-restart（npm `dsh-plugin-tray-restart@1.0.1`）

**策略：区域等长替换 + 空格补齐 + marker 幂等**

- `tray-patch.js`（10572 B）：`REGION_START`/`REGION_END` 定位，`PATCHED_REGION` 硬编码替换
- 兼容性前置校验：三个 token 存在性
- 幂等：区域内含 `MARKER_PREFIX` 时吞掉后续连续空格
- 长度断言：`source.length !== main.length` 抛错
- integrity：重算整文件 SHA-256 + 每 block SHA-256，原位替换 64 hex
- 卸载：`STOCK_TRAY_REGION` 硬编码 0.2.1-rc.3 原版区域
- `index.js`（2150 B）：`apply(ctx)` → 平台检查 → asar 路径 → mtime cache-bust → `applyTrayRestart` → 全程 try/catch 只 warn

**优点**：最小改动、不动其他代码、失败不破坏 asar
**缺点**：`STOCK_TRAY_REGION` 硬编码版本；不处理运行时 EPERM；不处理升级后首启旧菜单

### 2.2 ShawnZhangGy/dsh-tray-restart（npm `@shawnxiaoyang/dsh-tray-restart@0.1.0`）

**策略：9 个锚点文本替换 + 退出后换包**

- `lib/patch.mjs`（5914 B）：`replaceOnce` 强制「恰好 1 次」匹配，`AnchorError` 明确报错
- 5 处锚点编辑：托盘菜单项、quit 确认加 restart 模式、`requestTrayRestart`、`finishQuit` 加 relaunch、托盘 options 加 restart
- `lib/swapper.mjs`（10364 B）：detached 子进程轮询主进程 PID，退出后 `copyFileSync` 换包
- 安全护栏：换包前校验 `mainSha256` 与预期一致，否则丢弃（防覆盖新版本）
- 备份 + 校验 + 回滚
- 锁文件防并发
- `lib/asar.mjs`（10243 B）：`withNoAsar` 绕过 asar 拦截

**优点**：锚点法对版本变化更鲁棒；退出后换包彻底规避 EPERM；有备份回滚
**缺点**：复杂度高（8 个 lib 文件）；需要 detached 子进程；改动点更多

### 2.3 Joshua1ya/dsh-tray-restart（npm `dsh-tray-restart@0.2.1`）

**策略：完全不碰 asar，自起 WinForms 托盘**

- `assets/*.ps1`：PowerShell 起托盘图标
- `taskkill /T /F` + 重启
- 不修改任何宿主文件

**优点**：零侵入、零风险、升级不受影响
**缺点**：两个托盘图标；`taskkill /F` 强杀可能丢数据；需维护独立进程生命周期

### 2.4 三者对比

| 维度 | maqian1632 | ShawnZhangGy | Joshua1ya |
|---|---|---|---|
| 改 asar | 是（区域等长） | 是（锚点+换包） | 否 |
| 运行时 EPERM | 未处理 | 规避（退出后换包） | 不涉及 |
| 升级后首启 | 旧菜单 | 旧菜单 | 正常 |
| 卸载恢复 | 硬编码原版区域 | 备份回滚 | 不涉及 |
| 改动点 | 1 处区域 | 9 处锚点 | 0 |
| 复杂度 | 低 | 高 | 中 |
| 对 0.2.2-rc.3 | 可用（剩余 267 B） | 需验证 | 可用 |

## 三、与任务书的差异汇总（**需你确认**）

| # | 任务书 | 实测 | 影响 |
|---|---|---|---|
| 1 | `dataStart = 207179528` | **207179531** | 按任务书值读取会错位 |
| 2 | 托盘区域起始 759612 | **779389** | 同上 |
| 3 | `main.js` 语法残缺，`node --check` 报错 | **`node --check` exit 0，文件完整** | 「不做全文件语法校验」的前提不成立；旧插件失败根因需重新判定 |
| 4 | 运行时 EPERM 风险 | **`r+` 打开成功** | 风险等级下调（写入未测） |
| 5 | Program Files 写权限风险 | **W_OK 通过** | 风险等级下调 |
| 6 | 旧插件已完全卸载 | node_modules 已删，但 **patch.yml 残留 2 行** | 需清理 |

## 四、仍未验证的事项（留给后续阶段）

1. `writeSync` 到已映射的 asar 是否真的成功（`r+` 打开成功 ≠ 写入成功）
2. 补丁后 DSH 重启，托盘菜单是否真的出现「重启 DeepSeek Harness」
3. `app.relaunch()` + `quitWithoutConfirmation()` 的实际时序（是否有窗口期）
4. 中文 locale 下 `aboutProduct` 的实际文案
5. 自动更新（nightly 通道）覆盖 asar 后的行为

## 五、调研产物

- 参照仓库克隆：`.scratch/research/{mq,shawn,josh}`
- 探针脚本：`.scratch/research/probe-*.mjs`
- 提取的 main.js：`.scratch/research/main-extracted.js`（848505 B，只读副本，未改动原 asar）

> `.scratch/` 已在 `.gitignore` 中，不会提交。
