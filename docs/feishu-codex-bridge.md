# 飞书—Codex 对话桥

## 目标

- 持续接收管理员单聊及已接入群内真实 @ 机器人的消息。
- 只接受 `config/bridge.json` 白名单中的用户、会话类型和消息类型。
- 闲聊走轻量模型，业务走按用户、会话及任务隔离的执行器，以机器人身份回复原消息。
- 任务结果保存在本机账本；不依赖当前桌面聊天或每分钟 heartbeat。

## 数据流

1. `scripts/lark-event-listener.mjs` 常驻监听 `im.message.receive_v1`。
2. 原始事件追加到 `runtime/inbox.ndjson`；监听器不提前贴表情。
3. 文本进入常驻分类与对话进程；依据工作目标与上下文区分 chat/task，写入 `runtime/message-modes.ndjson`。正式分析、评审或制作请求即使无需工具也是 task。
4. chat 直接回复，回读后写入 `runtime/processed.ndjson`，不贴 OnIt/DONE。需要工具的非需求问答可以移交执行器，但保持 chat。
5. task 移交事件驱动的业务执行器，分类后添加 OnIt。图片、引用未解析、分类失败由执行器先判断模式，再处理。
6. 需求文字和必需附件全部成功并完成验收后添加 DONE，再 mark；失败保留待处理或阻塞。
7. 两通道共享 `docs/assistant-persona.md` 和 `knowledge/assistant-core.md`；日常使用 luna/low，需求使用 sol/high。参数以 `config/bridge.json` 为准。

## 当前边界

- 接受白名单用户单聊，以及白名单群内真实 @ 机器人的消息。管理员保留业务能力，其他真人成员只使用无工具受限短答，不读取历史、记忆、内部知识或个人飞书资源。
- 处理文本、富文本和图片消息；富文本中的嵌入图片也会下载并检查。
- 已接入的跨项目与飞书工作流按 `rules/rules.md` 授权范围执行；进入需求模式不等于取得业务写入授权。
- 本地监听依赖当前电脑在线且当前 Windows 用户已登录；电脑关机、休眠或用户尚未登录时不能实时收件。
- 监听器是事件驱动的：空闲时只保持飞书事件连接，不会每分钟轮询或唤醒 Codex。

## 本地操作

```powershell
npm run bridge:start
npm run bridge:status
npm run bridge:stop
npm run bridge:fetch-images -- <message_id>
node scripts/bridge-mode.mjs task --message-id <message_id>
npm run bridge:reaction -- processing --message-id <message_id>
npm run bridge:reaction -- done --message-id <message_id>
```

## 开机自启

安装 Windows 登录自启任务：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-bridge-autostart-task.ps1
Start-ScheduledTask -TaskName botCow-FeishuBridge
```

任务名为 `botCow-FeishuBridge`。它在当前 Windows 用户登录后运行一次，并每分钟由无控制台的 `wscript.exe` 调用 `run-bridge-watchdog-hidden.vbs`，再隐藏执行 `ensure-bridge-running.ps1` 做纯本地健康检查：监听器存在时立即退出，不存在时才通过 `start-bridge.ps1` 拉起隐藏、独立的 Node 监听进程。该检查不会显示 CMD/PowerShell 窗口，不读取消息队列、不唤醒 Codex，也不消耗模型 Token。任务禁止重复实例，并允许在电池供电时运行。

计划任务健康时通常显示 `Ready`，最近运行结果应为 `0x0`；真正的在线依据是 `runtime/listener.pid` 对应进程存在、命令行指向本项目，以及 `runtime/listener.log` 出现本次启动的 `[event] ready`。不要仅凭可能残留的 `listener-status.json` 判断在线。

检查任务与监听状态：

```powershell
Get-ScheduledTask -TaskName botCow-FeishuBridge
npm run bridge:status
```

卸载自启任务不会删除项目数据：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall-bridge-autostart-task.ps1
```

运行数据位于 `runtime/`，不应提交到版本库。

## 人格与知识维护

- `docs/personas/whale-character.md`：唯一角色正文；`docs/assistant-persona.md` 与 `docs/assistant-public-persona.md` 仅定义通道边界。
- `knowledge/assistant-core.md`：已确认的通用身份、能力和知识边界，条目保留来源与核对日期。
- 具体项目、私人资料和实时数据通过获授权工作流读取；不把所有聊天自动写入通用知识。新增人格或行为规则仍遵循用户确认要求。
- 人格与知识版本哈希变化会刷新后续预热线程和业务线程，不必为纯人格文本改动重启监听器；白名单等启动配置变更仍需等待工作完成后安全重启。

## 2026-11-13 记忆与任务线程架构

botCow 已实现 P0/P1，运行状态以 session 总账为准。配置、数据库恢复、有限灰度与回退说明见 [实施记录](../session/requirements/20261113-memory-architecture-implementation.md)。纯记忆操作不贴表情；业务线程按用户/会话/任务隔离，所有业务回复走 scoped-reply 入口。旧共享线程只作历史排查，禁止恢复。

## 并行与新增群

日常与业务通道可以同时运行；各自队列内部串行。业务通道仍共用全局锁，没有多个业务任务并行或按写入目标加锁。静态白名单在启动时读取；管理员邀请入群的动态准入由所有进程实时读取，无需重启。详见 spec/group-auto-admission-spec.md。

管理员本人邀请已视为授权，不再要求二次确认；只有手工修改静态配置才检查候选队列、等待活跃任务结束、暂停 watchdog 并安全重启。自动入群依赖后台入群/移出订阅，须验证实际邀请、群消息回复及飞书回读；仅收到事件或显示 ready 不代表响应成功。完整操作与公开发布边界见部署 spec 第 7 节和 spec/repository-publication-spec.md。
