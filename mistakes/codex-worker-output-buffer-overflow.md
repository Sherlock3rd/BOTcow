# Codex 事件执行器输出溢出

## 2026-11-03 现象
- 群指令 om_example 在 15:39 恢复运行，但 15:42:16 以 spawnSync ENOBUFS 退出。OnIt 留在原消息，任务仍 pending，没有完成回复。
- 执行器使用 spawnSync 捕获 Codex --json 的全部输出，maxBuffer 仅 50 MiB。大量输出导致执行器失败；不应把 OnIt 或 running 快照当作持续推进证据。

## 修复
- Codex stdout/stderr 直接写入每次运行的独立本地文件，不再以输出管道缓冲整个执行过程。
- 错误只读取 4000 字节尾部；轮换 thread.started 元数据使用有界行扫描，跳过大输出行。
- 55 MiB 子进程输出测试在 1 KiB maxBuffer 下通过；验证退出码、stdin、stderr、thread ID 和无末尾换行场景。
- 本次未重启监听器，确认无运行 worker 后恢复原待处理任务。失败状态已回复原群指令，未添加 DONE 或 mark。

## 防呆
- 模型执行输出不得全部积存在 spawnSync 缓冲区；不要仅增大 maxBuffer 掩盖问题。
- 文件位于被忽略的 runtime 内；不得提交或向群里发送包含完整历史的原始事件输出。
- 状态查询同时看真实 PID、错误日志、pending 和业务交付证据。恢复启动不代表业务已完成。
