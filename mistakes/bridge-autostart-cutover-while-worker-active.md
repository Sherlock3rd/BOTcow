# 监听器计划任务直接托管导致重启后离线

## 基本信息

- 日期：2026-08-19
- 分类：飞书事件监听 / Windows 自启
- 任务：将飞书监听器部署为 Windows 登录自启

## 问题现象

- 计划任务在手动启动和电脑重启登录后都能短暂显示 `Running`，随后监听进程退出，任务返回 `0xC000013A`。
- 残留的 `listener-status.json` 仍显示 `ready`，但其中 PID 已不存在。
- watchdog 改为每分钟短时计划任务后，交互式启动 `powershell.exe` 即使带 `-WindowStyle Hidden`，仍可能每分钟闪出 CMD/PowerShell 窗口。

## 原因分析

- 最初把 Node 监听器作为计划任务的长期直接 action；在当前 Windows/飞书 CLI 控制台进程组合下，进程会在任务会话生命周期变化时收到控制台终止信号。
- 电脑重启后的独立复现排除了“只由旧 worker 重叠导致”的原判断；旧 worker 重叠仍会增加切换风险，但不是根因。
- 状态文件是历史快照，不能证明对应进程当前存活。

## 修复动作

- 将计划任务 action 改为短时运行的 `ensure-bridge-running.ps1`，真实监听器由 `start-bridge.ps1` 创建为隐藏、独立进程。
- 增加登录触发和每分钟本地 watchdog；健康时只检查 PID/命令行并退出，不唤醒 Codex。
- 修复 `start-bridge.ps1`：清理失效 PID 和残留状态，并要求 ready 状态中的 PID 必须等于本次新进程。
- 将修正后的架构加入个人小助手部署 Spec v1.3。
- 计划任务 action 改为无控制台的 `wscript.exe`，由 `run-bridge-watchdog-hidden.vbs` 以窗口样式 `0` 启动 PowerShell 健康检查并等待退出。

## 预防办法

- 不使用计划任务长期直接托管 Node 监听器；使用短时 watchdog + 独立隐藏监听进程。
- watchdog 不得读取队列或启动 Codex，避免重新引入分钟级模型轮询。
- 不直接把交互式 `powershell.exe` 设为分钟级计划任务 action；`-WindowStyle Hidden` 不能保证完全无闪窗，应通过无控制台宿主启动。
- 验收同时检查计划任务最近结果、真实进程、命令行和本次 ready 日志；禁止只读状态 JSON。

## 执行前检查项

- [ ] 当前没有运行中的 Codex worker，或已等待其安全结束。
- [ ] 计划任务 action 指向 `ensure-bridge-running.ps1`，不是直接指向 Node。
- [ ] 计划任务最近结果为 `0x0`；健康时处于 `Ready` 是正常状态。
- [ ] 当前独立 PID 存活且命令行指向本项目监听器。
- [ ] 日志出现本次启动的 `[event] ready`，并建立飞书事件连接。
