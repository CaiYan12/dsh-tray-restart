# ADR-0001: 托盘重启补丁策略选型

- **状态**：已接受
- **日期**：2026-11-14
- **决策者**：项目所有者

## 背景

DSH 桌面端的托盘菜单由 Electron 主进程的 `DesktopTray` 类创建，Host 插件没有
任何 API 可以在其中插入菜单项。要加「重启」项，只能改打包进 `app.asar` 的
`lib/main.js`。

调研到三个活跃的同类实现：

| 实现 | 策略 |
|---|---|
| maqian1632/dsh-tray-restart | 区域等长替换 + 空格补齐 + marker 幂等 |
| ShawnZhangGy/dsh-tray-restart | 9 处锚点文本替换 + 退出后由 detached 子进程换包 |
| Joshua1ya/dsh-tray-restart | 完全不碰 asar，自起 WinForms 托盘 |

## 决策

采用 **maqian1632 式区域等长替换**，并借鉴 ShawnZhangGy 的两点做法：

1. 锚点必须「恰好匹配 1 次」，否则报错（`AnchorError` 式）；
2. 打补丁前备份 stock region 字节。

补丁内容采用**最小 diff**：在 stock 文本上只插入一项菜单，保留原有注释与格式。

## 理由

- **实测原位写入可行**：DSH 正在运行（9 个进程）时，对 `app.asar` 做
  `openSync(..., 'r+')` + `writeSync` 成功。ShawnZhangGy 用「退出后换包」规避的
  运行时 EPERM 在本机未复现，其核心优势因此不存在。
- **改动面最小**：只改 1254 字节的 tray region，`lib/main.js` 其余 84.7 万字节
  不动，总长度不变，asar 内所有偏移保持有效。
- **失败不破坏**：区域放不下或锚点校验失败时拒绝写入，asar 保持原样。
- **Joshua1ya 方案被否**：两个托盘图标是可见的产品缺陷，`taskkill /F` 有丢数据
  风险。

## 后果

- **升级后首次启动仍是旧菜单**：补丁对下一次启动生效。已接受，并改为「打补丁
  成功就弹一次提示」告知用户重启。
- **依赖 tray region 的文本形态**：DSH 若重写 `DesktopTray`，锚点会失效。届时
  插件拒绝写入并报错，不会写坏 asar。
- **恢复依赖备份文件**：备份存在 `~/.dsh/tray-restart-backup/`；备份丢失时无法
  精确恢复，只能靠 DSH 升级覆盖。

## 备选方案

- **ShawnZhangGy 式换包**：更鲁棒，但需 detached 子进程、8 个 lib 文件、备份
  校验与回滚逻辑，复杂度与收益不成正比。
- **Joshua1ya 式独立托盘**：零侵入，但双托盘图标与强杀风险不可接受。
