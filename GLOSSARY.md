# GLOSSARY

本项目领域术语。只放词汇定义，不放实现细节与决策理由（决策见 `docs/adr/`）。

## Tray region

`lib/main.js` 中 `//#region lib/types/tray.js` 与 `//#endregion` 之间的字节区间。整个
`DesktopTray` 类定义都在这段里。**唯一**被本插件修改的区域。

## Stock region

DSH 官方发布版本里的 tray region 原文，未经任何补丁修改。本插件用它判断
「当前区域是否已被改过」。

## Marker

写在 tray region 内的固定注释串 `/* dsh-tray-restart:`，用于证明「这个区域是
本插件写的」。有 marker = 已打补丁；无 marker = stock。

## Equal-length replacement

补丁手法：替换后的区域字节数必须 ≤ 原区域，不足部分用空格（`0x20`）补齐，
保证 `lib/main.js` 总长度不变。总长度不变意味着 asar 内所有后续文件的偏移
都不需要重算。

## DesktopTray

DSH 桌面端主进程里的托盘对象，负责创建托盘图标、设置 tooltip 和右键菜单。
菜单项由 `relabel()` 重建。

## Restart action

本插件新增的托盘菜单项。点击后执行 `app.relaunch()` 登记下次启动，再调用
`quitWithoutConfirmation()` 退出当前进程。

## quitWithoutConfirmation

DSH 主进程内的函数，设置 `skipQuitConfirmation = true` 后调用 `app.quit()`，
跳过「还有任务在跑」的确认对话框。

## finishQuit

DSH 主进程内真正执行退出的函数：销毁托盘 → 隐藏窗口 → 关闭 Host →
排空操作日志 → `app.quit()`。

## Backup

首次打补丁前保存的 stock region 原始字节，加一份 JSON 元信息（DSH 版本、
区域偏移、SHA-256）。卸载恢复时按它回写。

## Integrity record

asar header 里 `lib/main.js` 条目的 `integrity` 字段，含整文件 SHA-256 与按
`blockSize` 分块的 SHA-256 列表。本机 `EnableEmbeddedAsarIntegrityValidation`
为 DISABLED，但补丁后仍同步更新，避免其他工具校验失败。
