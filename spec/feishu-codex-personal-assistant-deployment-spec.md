# 飞书—Codex 个人小助手部署规范

## 0. 文档信息

- 规范版本：`v2.0`
- 基线日期：`2026-11-14`
- 参考实现：`D:\example\botCow` 中已运行的“牛马小助手”
- 适用平台：Windows 本机常驻、飞书自建应用、Codex CLI、`@larksuite/cli`
- 目标：让其他使用者可在 Codex 中按本规范部署自己的飞书小助手，并按需接入每日定点通报、授权项目和本地 Skills。

本规范固定当前“牛马小助手”已经验证的运行方式、交互细节和视觉基线；使用者的名称、收件人、Base、项目与 Skill 权限必须在部署时重新采集，不得复制现有用户 ID、会话 ID、应用密钥或业务地址。

## 1. 成品能力

完成部署后，小助手必须具备以下能力：

1. 接收白名单用户的单聊，以及白名单群中真实 @ 机器人的消息；其他群成员仅进入独立无工具短答通道。
2. 收到合格消息后先分类；仅需求消息添加 `OnIt`（处理中），日常对话不贴表情。
3. 由事件监听器按消息到达实时唤醒 Codex；没有消息时不轮询、不调用模型。
4. 在 Codex 中结合当前会话、项目规则和授权能力处理消息，再以机器人身份回复原消息。
5. 需求回复和全部附件成功后添加 `DONE`，再 mark；非需求回复回读后直接 mark。
6. 下载并检查飞书图片；本地 HTML、PDF、图片、报告等产物直接作为飞书附件交付。
7. 按授权白名单进入本地项目，调用项目自身规则和 Skill 完成任务。
8. 展示当前已授权的本地 Skill 能力清单，并说明各 Skill 的确认边界。
9. 使用独立系统计划任务执行每日定点通报，不依赖飞书消息或 Codex 对话轮询。
10. 使用 SQLite 显式记忆与按用户、会话、任务隔离的业务线程；不得恢复历史跨聊天共享线程。
11. 使用独立 Windows 登录自启与本地 watchdog 任务确保飞书事件监听器常驻；监听器异常退出后自动拉起，电脑重启并重新登录后无需人工恢复。

## 2. 核心架构

```text
飞书用户消息
  → lark-cli event consume im.message.receive_v1
  → inbox.ndjson（本机原始事件，禁止发布）
  → 用户 / 群 / 真实 @ 准入、去重与 blocked 检查
  → 日常通道分类 chat/task（只有 task 添加 OnIt）
      ├─ 管理员 chat：轻量模型 / 直接只读 / 显式记忆
      ├─ 群访客：当前文本、限流、无工具短答
      └─ 业务通道：全局串行锁 → 按范围隔离的 Codex 任务线程
  → 项目 / Skill 路由与权限门禁
  → 文字回复 + 必需附件
  → task 添加 DONE；chat 跳过表情
  → processed.ndjson

独立系统计划任务
  → 日期 / 节假日判定
  → 读取通报数据源
  → 构造 Card 2.0
  → 按日期幂等发送
```

### 2.1 强制架构原则

- 对话桥必须事件驱动；禁止用“每分钟唤醒 Codex 检查队列”作为正式方案。
- 每日定点通报必须使用 Windows 计划任务或等价系统调度器，禁止依赖收到飞书消息才触发。
- 飞书监听器只负责接收、入队、准入和唤醒，不分类、不提前贴表情，也不直接实现业务推理。
- 日常通道与业务通道可同时运行，各通道内部串行；同一时间只允许一个业务执行器。按范围隔离线程不等于按会话并行执行。重复事件依靠 `message_id`、反应账本和完成账本去重。
- 静态白名单在进程启动时加载，手工配置变更需要安全重启。2026-11-14 新增管理员邀请自动接入：动态准入状态由所有进程实时读取，后续入群无需重启；依赖后台成员事件订阅。多个业务任务并行及按写入目标加锁仍未实现。
- 实时项目文件、飞书 Schema 与实际权限永远优先于会话摘要和历史说明。

## 3. 部署期间的反问协议

部署 Agent 可以且应当向使用者反问。只有会实质改变权限、数据目标、业务结果或视觉语气的问题才需要阻断确认；其余环境探测和脚手架可直接完成。

### 3.1 第一轮必须采集

| 类别 | 必须询问的信息 | 示例 |
|---|---|---|
| 助手身份 | 机器人名称、称呼使用者的方式、回复前缀 | 名称“牛马小助手”；不加固定回复前缀 |
| 使用者 | 允许发消息的人员或群；默认只允许本人单聊 | 张三；仅 p2p |
| 运行环境 | 本机常驻、服务器或其他环境；是否允许开机自启 | Windows 本机常驻 |
| 对话输入 | 允许的消息类型 | text / post / image |
| 每日通报 | 是否启用、时间、时区、数据源、目标会话、空数据策略 | 工作日 10:00；Asia/Shanghai |
| 项目访问 | 允许进入的项目根目录、允许动作、只读或可写 | `D:\project\foo`；允许生成 Review |
| Skill | 允许的 Skill 根目录或明确清单；需排除的目录 | `.cursor\skills`；排除 `\tmp\` |
| 写入门禁 | 哪些动作可直接做，哪些必须二次确认 | Apply、权限、正式设计需确认 |

### 3.2 条件触发反问

- 使用者要求写排期时：询问排期 Base URL，以及字段含义、必填项、默认状态、负责人解析方式。
- 使用者要求每日通报时：询问数据源、筛选条件、发送频率、节假日口径、无数据是否发送、卡片标题与目标会话。
- 使用者允许访问项目时：询问项目根目录、项目规则入口、Mistakes 目录、Skill 入口、允许读写范围、发布目标和高风险门禁。
- 使用者允许全部 Skills 时：询问正式 Skill 根目录与临时/缓存排除规则；“全部”不得绕过每个 Skill 自身的确认要求。
- 使用者要求联系人简称时：询问简称、真实姓名，并在当前飞书应用身份下重新解析 open_id。
- 使用者要求自定义语气或视觉时：先给出当前基线，再确认哪些 token 可以变；未确认时保持本规范默认值。
- 使用者要求群聊时：重新确认允许群、是否必须 @机器人、群成员可见范围以及群写入权限；不得把单聊授权自动扩展到群聊。

### 3.3 可直接采用的默认值

- 默认语言：简体中文。
- 默认对话：仅白名单用户的 p2p 单聊。
- 默认消息：`text`、`post`、`image`。
- 默认状态表情：处理中 `OnIt`，完成 `DONE`。
- 默认发送身份：对话回复使用 bot；个人飞书资源操作按需使用 user。
- 默认会话轮换：30 天。
- 默认卡片：Card 2.0、`default` 宽度、无回调按钮。
- 默认高风险行为：等待书面确认。

## 4. 环境与依赖

### 4.1 基础环境

- Windows 10/11。
- Node.js `>=22.17.1 <23`，与 `package.json` 一致；SQLite 使用 `node:sqlite`。
- npm。
- Codex CLI。
- `@larksuite/cli` 及其正式 Skills。
- 一台在需要收消息与执行任务时保持在线的电脑。
- 当前 Windows 用户已登录，且该用户的飞书 CLI 与 Codex CLI 登录状态有效；Codex 桌面窗口不需要保持前台打开。

### 4.2 本地常驻边界

- 锁定屏幕不会终止监听器或 Codex CLI；电脑仍在线时可以继续接收和处理事件。
- 电脑睡眠期间进程暂停、网络连接中断，不能实时处理消息；恢复后监听器应自动重连。
- 电脑关机或 Windows 用户尚未登录时，本地助手不运行；需要无登录常驻时，应改用专用服务器或 Windows Service，并重新设计凭证保存与权限边界。
- 空闲监听只维持飞书事件连接，不轮询 Codex、不定时调用模型；只有合格飞书消息到达时才唤醒 Codex worker。

### 4.3 安装与验证

```powershell
node --version
npm --version
npm install -g @larksuite/cli
npx skills add https://github.com/larksuite/cli -y -g
lark-cli --version
codex --version
```

Windows 安装失败时，遵循 `spec/feishu-cli-deployment-and-doc-ops-spec.md` 中已验证的二进制补装和 Skills 路径规避方案。

## 5. 飞书应用、身份与授权

### 5.1 独立 Profile

- 每个小助手使用独立飞书应用和独立 CLI profile。
- 不覆盖全局活跃 profile；每条命令显式写 `--profile <assistant_profile>`。
- 应用名称与飞书中显示的机器人名称一致。
- 凭证只能进入 CLI 安全配置或环境变量，不得进入仓库、日志、Spec 或会话文档。

### 5.2 身份规则

| 操作 | 默认身份 | 原因 |
|---|---|---|
| 接收消息、回复、主动提醒、表情 | `bot` | 以助手名称行动 |
| 用户个人云空间、个人文档、个人 Base | `user` | 需要使用者自己的访问权 |
| 项目本地文件 | 本机进程身份 | 由项目白名单约束 |

- Bot 缺 scope：到飞书开发者后台开通，不对 bot 执行 `auth login`。
- User 缺 scope：执行最小范围 `auth login --scope` 或 `--domain`。
- 授权链接必须原样展示，并生成二维码；授权完成后由部署 Agent 执行 `--device-code` 收尾。
- `open_id` 与应用绑定，禁止复用其他应用解析出的 ID。

### 5.3 最小能力范围

实际 scope 以实时错误返回的 `missing_scopes` 和目标能力为准。常见能力包括：

- 机器人收发消息。
- 读取消息和下载消息资源。
- 创建和读取消息表情。
- 按需读取联系人。
- 若启用 Base、文档或云盘，再分别增加对应最小 scope。

验收必须执行：

```powershell
lark-cli auth status --profile <assistant_profile> --json --verify
lark-cli doctor --profile <assistant_profile>
```

成功判断使用 `ok=true`、有效身份和验证状态，不使用旧式顶层 `code==0` 判断。

## 6. 项目目录规范

建议目录：

```text
assistant-project/
├─ AGENTS.md
├─ rules/rules.md
├─ spec/
│  ├─ assistant-operating-workflows-spec.md
│  └─ feishu-codex-personal-assistant-deployment-spec.md
├─ session/
│  ├─ session.md
│  ├─ codex-event-thread-handoff.md
│  └─ requirements/feishu-conversation-bot.md
├─ mistakes/
├─ docs/
├─ config/
│  ├─ bridge.json
│  ├─ assistant-workflows.json
│  ├─ contact-aliases.json
│  ├─ overdue-filter.json
│  └─ cn-holidays-YYYY.json
├─ scripts/
└─ runtime/
```

- `runtime/` 保存队列、日志、PID、状态、下载图片和临时卡片，不进入版本库。
- `config/` 只保存非敏感路由信息；不得保存 token、secret、device code 或授权 URL。
- 新项目首次实质工作前，按团队基础规则初始化 `rules/`、`session/`、`mistakes/`、`spec/` 和 `docs/`。

## 7. 对话桥配置

`config/bridge.json` 的完整可复制结构见 `config/bridge.example.json`。以下为最小结构示意；新部署须填写本应用解析的身份，并在验证后启用事件唤醒和群访客能力：

```json
{
  "profile": "<assistant_profile>",
  "chat_model": "gpt-5.6-luna",
  "chat_reasoning_effort": "low",
  "event_key": "im.message.receive_v1",
  "allowed_sender_ids": ["<open_id_resolved_by_this_app>"],
  "allowed_chat_types": ["p2p"],
  "allowed_group_chat_ids": [],
  "bot_open_id": "<bot_open_id>",
  "allowed_message_types": ["text", "post", "image"],
  "reaction_types": {
    "processing": "OnIt",
    "done": "DONE"
  },
  "bot_name": "<assistant_name>",
  "sync_target": "scoped_task_threads",
  "memory": {"enabled": true, "read_enabled": true, "write_enabled": true, "task_isolation": true, "automatic_candidates": false},
  "group_public": {"enabled": false},
  "auto_group_admission": {"enabled": false, "app_id": "<app_id>", "enabled_at": null},
  "risk_control": {"enabled": true, "max_input_chars": 12000},
  "event_wakeup": {
    "enabled": false,
    "model": "gpt-5.6-sol",
    "reasoning_effort": "high",
    "thread_id": null,
    "thread_started_at": null,
    "rotation_days": 30,
    "handoff_path": "session/codex-event-thread-handoff.md",
    "retry_delay_ms": 15000
  }
}
```

### 7.1 白名单

仅处理同时满足以下条件的事件：

- 有合法 `message_id`。
- `sender_type=user`。
- 私聊的 `sender_id` 必须位于管理员白名单；群聊则必须是获准群且真实 mentions 包含 `bot_open_id`。群管理员沿用原能力；非管理员仅在 `group_public.enabled=true` 时进入受限短答，不能继承业务权限。
- `chat_type` 位于允许列表。
- `message_type` 位于允许列表。

不合格消息可以记录最小诊断信息，但不得唤醒 Codex、回复、下载资源或扩大权限。

群访客默认单条 4000 字符，每人每分钟 6 次/每小时 30 次，每群每小时 60 次，全体每小时 100 次；模型预算 12 秒。具体配置及失败处理见 `docs/group-public-risk-controls.md`。不加载历史、引用、私人记忆、内部知识或本机项目，不失败升级到业务通道。

### 7.2 新增群和安全加载配置

管理员本人邀请机器人入群视为接入授权，不再要求确认第二次。订阅和动态状态规范见 `spec/group-auto-admission-spec.md`；邀请者必须由真实事件核对。以下为手工新增/修复静态配置的流程，不要求每次自动入群都重启。

1. 从实际收到的事件核对 chat_id、sender_id、mentions；收到消息不等于通过准入。
2. 取得该群接入授权，只增加明确的群；核对扩容后会进入队列的历史消息，禁止批量回放旧访客消息。
3. 等待两通道当前工作完成，核对 pending、处理锁和真实 PID。状态文件可能滞后，不能单独作为依据。
4. 暂停本项目 watchdog，优雅停止监听器，确认旧聊天 worker 已退出。保存原配置并检查没有并发修改，再写入最小变更。
5. 启动监听器并验证新 PID、命令行、本次 ready 日志；无论成功或失败都恢复原 watchdog 启用状态。启动失败时恢复原配置和监听服务。
6. 验证真实群消息的分类、回复 ID、飞书回读和完成账本，区分配置校验、进程就绪与端到端验收。不要因加群重放其他历史任务。

### 7.3 复制参考实现时必须参数化

不得整目录复制后直接运行。至少检查并替换：

- `config/bridge.json`：profile、机器人名、白名单 open_id、Codex thread、交接摘要路径。
- `config/assistant-workflows.json`：项目根目录、Skill 根目录、Base、字段、目标 chat_id、时区与时间。
- `scripts/codex-event-wakeup.mjs`：唤醒提示中的工作目录、双方显示名和必读 Spec。
- `scripts/reply-card.mjs`：禁止保留硬编码 `botCow` profile，应读取当前助手配置。
- `scripts/install-overdue-alert-task.ps1`：计划任务名称、描述、runner 文件名和触发时间。
- Card builder：使用者称呼、卡片标题、数据字段和源链接。
- `config/contact-aliases.json`：删除参考实现别名，在当前应用下重新解析。
- 年度节假日文件：按当前年份更新并记录权威来源。

`runtime/`、二维码、授权链接、PID、日志、队列、下载图片和历史卡片实例都不得复制到新助手。

## 8. 事件监听与唤醒

### 8.1 事件入口

监听命令：

```powershell
lark-cli event consume im.message.receive_v1 --profile <assistant_profile> --as bot
```

- 以 stderr 的 `[event] ready event_key=...` 作为就绪标志，不使用固定 sleep 判断。
- stdout 按 NDJSON 逐行解析。
- 长连接异常时指数退避重启，上限 30 秒。
- 停止时使用 SIGTERM 或关闭 stdin；禁止强杀造成订阅残留。

### 8.2 队列与唤醒

- 监听输出的原始事件追加到 `runtime/inbox.ndjson`，准入在唤醒及 pending 阶段共同校验；该文件可能包含未准入消息，必须仅本机保存。
- `runtime/processed.ndjson` 记录已完成 `message_id` 和回复 ID。
- pending 读取按 `message_id` 去重，一次最多向 worker 暴露有限数量。
- 监听器收到合格事件后立即触发 Codex worker；worker 使用锁文件串行执行。
- worker 只处理当前队列头，成功 mark 后继续下一条；当前消息仍 pending 时必须报错停止，不能跳过。
- pending 不等于立即无限重试。对 `missing_scope`、`app_scope_not_applied`、明确 ACL 拒绝、目标不存在等非瞬时错误，必须记录稳定错误指纹并暂停该消息的自动唤醒；等待权限、目标或用户指令发生变化后再人工恢复。
- 仅对网络中断、限流、服务端暂时错误等可恢复故障进行自动重试；使用指数退避与最大次数，禁止每次监听循环都重新唤醒 Codex。
- 同一 `message_id + 错误指纹` 连续失败达到阈值后进入 blocked/quarantine 状态，并向运行状态写入真实原因；不得删除事件、伪造完成或持续消耗模型调用。
- Codex 最长执行时间应有限制；参考实现为 30 分钟。

### 8.3 Codex 会话

- 业务线程通过 `task-session-registry.mjs` 按当前用户、会话及任务创建或恢复，统一输入由 `context-builder.mjs` 生成。使用 `codex exec` 创建，已有线程使用 `resume`；逐个禁用无关 MCP，清单位于 `event_wakeup.disabled_mcp_servers`。不要使用 `--ignore-user-config`，否则会丢失部署者的 headless 执行策略。
- 在 `event_wakeup.model` 固定一个与专用 thread、当前 Codex CLI 均兼容的模型，并在唤醒命令中显式传入 `--model`；部署验收必须覆盖“切换交互式 Codex 默认模型后，机器人仍能处理消息”。
- 唤醒提示必须写明：工作目录、目标 `message_id`、必读规则/Spec/Mistakes、图片路径、回复身份、DONE 与 mark 顺序。
- 隔离模式根据任务状态、scope_epoch 和人格/知识版本选择线程；共享线程的 30 天轮换字段属于兼容逻辑，不是当前隔离任务的唯一生命周期。旧共享线程不得恢复。
- 会话轮换不重启飞书监听器。
- 日常模型关闭自动 memories 与 skills 注入；业务模型关闭自动 memories，只按本次范围读取材料。纯显式记忆事务成功后才回复，纠正/停用提升范围版本。历史助手原文作为按需证据，不作为口吻示例。共同角色正文仅 `docs/personas/whale-character.md`，通道文件只声明边界。

### 8.4 监听器登录自启与故障恢复

- Windows 本机部署默认使用“当前用户登录后启动”，不是系统启动前的无人值守服务。
- 监听器自启必须使用独立计划任务；任务动作使用无控制台的 `wscript.exe` 调用 `scripts/run-bridge-watchdog-hidden.vbs`，再由其隐藏执行 `scripts/ensure-bridge-running.ps1`。健康检查只在监听器不存在时调用 `scripts/start-bridge.ps1` 启动隐藏、独立的 Node 监听进程。
- 禁止让计划任务长期直接托管 `node scripts/lark-event-listener.mjs`。当前 Windows/飞书 CLI 组合下，该控制台进程可能在任务会话结束时收到 `0xC000013A`，即使已经出现 `[event] ready` 也会离线。
- 推荐任务名：`<assistant>-FeishuBridge`；参考实现为 `botCow-FeishuBridge`。
- 触发器：当前 Windows 用户 `AtLogOn`，并额外每 1 分钟执行一次本地健康检查。
- watchdog 只检查本地 PID、进程命令行与监听状态；健康时立即退出，监听器不存在时才重新启动。它不得读取消息队列、唤醒 Codex 或调用模型。
- 禁止把分钟级 watchdog 直接配置成当前用户交互式 `powershell.exe` action；即使带 `-WindowStyle Hidden`，部分 Windows 环境仍会先闪出控制台窗口。
- 设置：`StartWhenAvailable`、watchdog 执行时限 2 分钟、`MultipleInstances=IgnoreNew`、允许电池供电。
- 安装或升级自启任务时，先检查 `codex-wakeup-status.json`、worker 锁和实际 PID；如仍有消息处理 worker，等待其完成后再优雅停止手动监听实例。禁止在 worker 运行中强行切换监听器，以免旧进程组的退出信号影响新任务。
- 确认没有活动 worker 后，再注册任务并立即启动，避免重复订阅。
- 状态文件可能在异常重启后残留；不得仅凭 `listener-status.json` 宣称在线。启动脚本必须清除失效 PID 与旧状态快照，并只接受 `status.pid` 等于本次新进程 PID 的 ready 状态。
- watchdog 计划任务健康时通常为 `Ready` 且最近结果为 `0x0`；不得要求它长期显示 `Running`。在线判断必须验证 `listener.pid` 对应进程真实存在、命令行指向当前项目监听器，以及日志出现本次启动的 `[event] ready`。
- 自启任务只保持事件入口常驻，不产生分钟级 Codex 轮询；无合格事件时不得启动 worker。

## 9. 消息状态与完成事务

每条消息先分类并写入 message-modes.ndjson；chat 回复回读后直接 mark，绝不贴表情。以下为 task 的完成顺序：

1. 收到并通过白名单。
2. 确认 task 分类后幂等添加 `OnIt`；图片或引用尚未读懂时先完成判断。
3. 下载并检查图片或富文本嵌入图片（如有）。
4. 执行业务任务。
5. 回复文字或 Card。
6. 发送全部必需附件。
7. 幂等添加 `DONE`。
8. 将 `message_id` 和文字回复 ID 写入 processed ledger。
9. 在 Codex 当前任务中同步双方原文。

任一步失败：

- 保留事件为 pending。
- 报告真实错误。
- 不伪造回复、附件、图片检查或同步成功。
- 重试继续使用相同稳定幂等键。
- 先区分瞬时故障与永久性/需人工处理故障；只有瞬时故障进入自动退避重试。
- 缺应用 scope、缺用户授权、ACL 拒绝或目标资源不可写时，将消息置为 blocked/quarantine，停止事件驱动重复唤醒，并给出恢复条件。
- 用户明确选择手动完成远端写入时，可以保留已验证的本地交付物并回复其路径/文件名；该远端写入不宣称成功。若用户同时明确要求结束该消息，可在回复说明“仅本地完成、远端由用户手动处理”后执行 DONE 与 mark。

## 10. 回复规范

### 10.1 默认文本回复

- 简体中文。
- 不加固定前缀；语气以 `docs/personas/whale-character.md` 为准，任务结果遵循通道边界和业务回执要求。
- 先说结果，再说明必要边界或下一步。
- 普通问答简洁直接；任务完成回复包含结果、关键验证和可点击交付链接。
- 涉及写入确认时，明确列出目标、范围、将发生的动作和当前 Review/版本标识。
- 不暴露 token、secret、授权码、内部凭证或不必要的内部日志。

推荐格式：

```text
<一句话结果>。

已完成：
1. <关键结果>
2. <关键结果>

验证：<回读或部署状态>
链接：<用户可打开的地址>
需要你确认：<仅在存在门禁时出现>
```

### 10.2 消息类型

- 简短、需要原样保留：`--text`。
- 标题、列表、链接、摘要：优先 `--markdown`。
- 能力介绍、每日通报、结构化状态：Card 2.0。
- 需要在飞书对话中直接预览的 PNG、JPG、JPEG、GIF、WebP 等图片：从图片所在目录使用相对路径，以 `--image` 单独发送。不得用 `--file` 代替图片消息，否则飞书只会显示普通文件附件。
- HTML、PDF、Markdown、压缩包、报告及用户明确要求“作为文件下载”的图片：从文件所在目录使用相对路径，以 `--file` 单独发送。
- 文字和每个附件分别使用稳定幂等键，最大 50 字符。

### 10.3 附件规则

- HTML、PDF、图片、报告等供用户查看的本地产物必须发送到飞书，禁止只给本机路径。
- 图片默认作为图片消息发送，以便在对话框中直接预览；只有用户明确要求下载原文件时，才把图片作为普通文件附件发送。
- `--image` 与 `--file` 的选择必须按交付形态决定：图片预览用 `--image`，普通文件附件用 `--file`。不得仅因为源文件位于本机就统一使用 `--file`。
- 文字回复与媒体是独立消息；一个命令不得混用 `--text`、`--image` 和 `--file`。
- 所有必需附件均返回 `ok=true` 后才能添加 DONE。
- 图片输入只用于理解当前请求，不自动授权项目写入、文档写入或高风险操作。

## 11. Card 2.0 视觉规范

所有卡片必须按 `lark-im` 的 Card 2.0 创建工作流生成，并完成 P0–P7 自检；禁止从本规范直接复制 JSON 后不检查即发送。

### 11.1 能力介绍卡

当前“牛马小助手”视觉作为默认基线：

- Card 2.0。
- Header：`blue`。
- 宽度：`default`。
- 图标：`ai-common_colorful`。
- Header 标题：`<助手名称>能力地图`。
- Header 副标题：`当前已接通能力与执行边界`。
- 蓝色 Tag：`事件驱动`。
- Body：`12px 12px 20px 12px` padding，`12px` 垂直间距。
- 首块使用 `blue-50` 指标/边界面板。
- 能力块采用两列 `column_set`，交替使用 `blue-50` 与 `violet-50`。
- 次要说明使用 grey；主标题使用 blue/violet 加粗。
- 默认无按钮、表单或回调；只有使用者明确要求操作入口时才设计 callback。

能力卡至少展示：

1. 飞书图文对话与附件。
2. 已授权项目访问。
3. 排期或业务数据写入能力。
4. 每日定点通报。
5. 当前本地 Skills。
6. 联系人和消息能力（如启用）。
7. 事件驱动、空闲静默与会话轮换。
8. 明确的权限边界。

### 11.2 每日通报卡

当前通报视觉作为默认基线：

- Header 主色始终为 `green`，标题保持人文关怀语气。
- 默认标题：`早上好，<使用者称呼>`。
- 首段以 `<回复前缀>` 开头，先表达关怀，再进入状态。
- 正常状态：绿色指标底板和正向反馈。
- 需要关注：增加橙色“需要关注”Tag；只有异常数字和任务文本使用红/橙强调。
- 指标区：左侧数量卡，右侧今日状态卡；状态卡使用 `grey-50`。
- 明细至少包含任务名、优先级、状态、负责人、检查日期和超时天数。
- 末尾用 grey 给出完整数据源链接。
- 不把整张卡改成红色，避免警报压迫感。

### 11.3 视觉自定义门禁

机器人名称、使用者称呼、标题文字可以在部署时直接配置；主色、布局、组件组合、交互按钮属于视觉/交互变更，必须由使用者书面确认后偏离上述基线。

## 12. 项目访问功能

### 12.1 项目白名单模型

每个项目配置以下信息：

```json
{
  "id": "<project_id>",
  "root": "D:\\path\\to\\project",
  "intents": ["<route keyword or intent>"],
  "rules": ["AGENTS.md", "rules/rules.md"],
  "mistakes": "mistakes",
  "skill_entry": "SKILL.md",
  "access": "read | review | write",
  "write_gates": ["explicit_confirmation", "review_id", "read_back"],
  "publish_target": null
}
```

### 12.2 调用前置

每次跨项目调用必须：

1. 验证项目在白名单内，解析后的绝对路径仍位于授权根目录。
2. 读取目标项目的 `AGENTS.md`、规则、相关 Mistakes。
3. 读取选中 `SKILL.md` 及其声明的必读 references。
4. 读取目标当前状态；实时 Schema、Rows、代码和远端状态优先。
5. 只执行当前消息授权的最小完整动作。
6. 对写入按目标项目门禁确认、回读并记录。

“允许访问项目”不等于“允许任意发布、删除、改权限或绕过 Review”。

### 12.3 当前参考实现

“牛马小助手”目前采用的项目路由示例：

- 配置修改：进入 `D:\example\cousin`，先 Dry-run，生成 HTML 差异与 Review ID；Apply 必须确认当前 Review ID。
- Dobe 页面发布：仅在明确发布授权后修改既有 GitHub Pages，完成工作流与线上回读，再发送提交和页面链接。

其他使用者部署时必须替换为自己的项目列表和门禁，不自动继承上述路径或权限。

## 13. 本地 Skill 接入与展示

### 13.1 授权配置

```json
{
  "skill_roots": ["D:\\path\\to\\skills"],
  "allow_all_formal_skills": true,
  "allowed_skills": [],
  "exclude_paths_containing": ["\\tmp\\", "\\cache\\"],
  "require_skill_rules": true
}
```

- `allow_all_formal_skills=true` 表示可从正式根目录选择匹配 Skill，不表示自动执行全部 Skill。
- 若为最小权限，改用 `allowed_skills` 明确列出名称。
- 排除临时副本、缓存、部署拷贝和重复 Skill。

### 13.2 发现规则

部署或刷新能力卡时：

1. 在授权根目录中发现正式 `SKILL.md`。
2. 过滤排除路径。
3. 读取 Skill 名称与描述，不运行 Skill。
4. 将名称、能力摘要、写入门禁和当前可用状态生成快照。
5. 能力卡展示业务化名称，不向普通使用者堆砌本机路径。
6. 实际调用时再次读取完整 Skill 和必读 references，不能只依赖展示快照。

### 13.3 当前参考 Skill 清单

当前 Workbencch 基线展示以下正式 Skills：

- `feishu-meeting-minutes-email-draft`
- `feishu-sheet-importer`
- `game-early-experience-breakdown`
- `levelpoints-html-editor-writeback`
- `levelpoints-navmesh-viewer`
- `navmesh-point-visualizer`
- `planning-analytics-tracking`
- `planning-announcement-requirements`
- `planning-audio-requirements`
- `ux-text-requirements-generator`

此清单仅作为当前美术与展示密度参考；新助手必须展示自己扫描到且已授权的 Skills。

## 14. 每日定点通报

### 14.1 配置模型

```json
{
  "enabled": true,
  "name": "<report_name>",
  "timezone": "Asia/Shanghai",
  "time": "10:00",
  "weekdays": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
  "weekend_makeup_policy": "skip",
  "holiday_calendar": "config/cn-holidays-YYYY.json",
  "source": {
    "type": "lark_base",
    "url": "<base_url>",
    "filter": "config/<filter>.json"
  },
  "chat_id": "<target_chat_id>",
  "profile": "<assistant_profile>",
  "send_when_empty": true,
  "idempotency_prefix": "<short-prefix>"
}
```

### 14.2 必须由使用者确认的内容

- 数据源与视图。
- 通报判定字段或筛选表达式。
- 通报时间与时区。
- 周末、调休和法定节假日口径。
- 无数据时静默，还是发送绿色正常卡。
- 目标用户或群聊。
- 明细字段、排序和最多展示数量。

当前参考实现固定使用 `send_when_empty=true`，无异常也发送绿色正常卡；现有 runner 尚未实现 false 分支，不能只改配置就承诺静默。新部署如需静默，须先取得该行为变更授权，再实现 `skipped_empty` 分支并验证；本次文档同步不改变现有发送策略。

### 14.3 调度规则

- 使用独立 Windows 计划任务。
- 计划任务按周一至周五触发；当前基线即使周末调休也不发送。
- runner 再读取年度中国法定节假日配置；缺失当年配置时停止发送并记录错误，禁止猜测。
- 系统唤醒后补跑使用 `StartWhenAvailable`；同一时间只允许一个实例。
- 任务设置执行时限；参考实现为 10 分钟。

### 14.4 查询与发送

1. 判定当天是否允许运行。
2. 读取实时数据源 Schema 和数据。
3. 在服务端应用筛选，并翻页到 `has_more=false`。
4. 构造 Card 2.0。
5. 使用 `<prefix>-YYYYMMDD` 稳定幂等键发送。
6. 只有 `ok=true` 才记录成功。
7. 写入当天状态文件和可审计日志，但不记录凭证。

每日通报可以直接查询并构造确定性卡片，不需要为了固定格式而唤醒 Codex；仅在通报内容需要模型总结时，才单独评估模型调用成本和失败降级方案。

## 15. 运行与维护

### 15.1 服务命令

```powershell
npm run bridge:start
npm run bridge:status
npm run bridge:stop
```

- 启动脚本使用隐藏窗口运行监听器，并等待真实 ready 状态。
- 状态包含 listener 状态、收件数量和已处理数量。
- 停止脚本通过 stop 文件请求优雅退出。

### 15.2 计划任务

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-bridge-autostart-task.ps1
Start-ScheduledTask -TaskName "<assistant>-FeishuBridge"
Get-ScheduledTask -TaskName "<assistant>-FeishuBridge"
Get-ScheduledTaskInfo -TaskName "<assistant>-FeishuBridge"

powershell -ExecutionPolicy Bypass -File .\scripts\install-overdue-alert-task.ps1
Get-ScheduledTask -TaskName "<assistant>-DailyReport"
Get-ScheduledTaskInfo -TaskName "<assistant>-DailyReport"
```

监听器 watchdog 与每日通报任务是两个独立任务：前者每分钟做一次纯本地进程健康检查并立即退出，真实监听器是独立隐藏进程；后者只在定点时刻短暂运行。两者均不得在空闲时唤醒 Codex。计划任务名称、runner 和工作目录必须属于当前助手项目，禁止多个助手共用同一个任务名。

卸载监听器自启任务：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall-bridge-autostart-task.ps1
```

卸载任务不得删除队列、日志、下载文件或其他运行数据；如需清理运行数据，必须单独确认范围。

### 15.3 日志与状态

至少保留：

- `listener-status.json`
- `listener.log`
- `codex-wakeup-status.json`
- `codex-wakeup.log`
- `daily-report-status.json`
- `daily-report.log`
- `inbox.ndjson`
- `processed.ndjson`
- `reactions.ndjson`

日志轮转、保留天数和磁盘上限可在部署时配置；凭证、授权码、完整敏感正文不得写入长期日志。

## 16. 权限与确认矩阵

| 动作 | 默认策略 |
|---|---|
| 普通问答、解释、识图 | 可直接执行 |
| 读取白名单项目 | 可直接执行并说明来源 |
| 生成本地草稿、Dry-run、Review 文件 | 可直接执行并作为附件交付 |
| 用户明确要求写入某条排期 | 视为该条记录写入授权；写后回读 |
| 一般飞书文档/Base 写入 | 目标和范围明确后执行；遵循对应 Skill |
| 配置服务器 Apply | 必须确认当前 Review ID |
| 权限调整、删除、覆盖、高风险写入 | 必须明确二次确认 |
| 正式设计、交互意图、命名规则、输出格式变更 | 必须书面确认 |
| Git 发布 | 必须有明确发布授权，并验证远端与线上结果 |

图片、附件、项目访问授权和“允许全部 Skills”均不得扩大此矩阵。

## 17. 幂等、安全与失败恢复

- 消息回复：基于 `message_id` 的稳定键，不超过 50 字符。
- 多附件：每个附件使用 `message_id + 文件名摘要` 的独立稳定键。
- 每日通报：基于日期的稳定键。
- 表情：以 `message_id + status` 写反应账本。
- 队列完成：task 须在回复、附件和 DONE 全部成功后 mark；chat 回复回读后直接 mark。
- 路径：所有来自消息的文件路径必须限制在消息下载目录；禁止目录穿越。
- 本地发送文件必须使用 cwd 相对路径。
- 高风险 CLI 返回 confirmation-required 时，不自动追加 `--yes`。
- 重启后依据 ledger 恢复，不按“进程曾经运行过”推断任务完成。
- 为失败记录 `message_id`、错误类型、错误指纹、首次/最近失败时间、尝试次数、下次允许重试时间和恢复条件；不得记录凭证。
- 自动重试默认只覆盖瞬时错误，并采用指数退避；权限与 ACL 类错误必须等待外部状态变化或用户明确恢复。
- 用户选择手动替换远端文件时，本地文件必须先完成内容校验，并明确区分“本地 spec 已更新”和“飞书远端文件尚未替换”。

## 18. 验收清单

### 18.1 应用与身份

- [ ] 独立 profile 可验证，应用名与机器人名一致。
- [ ] Bot 身份 ready，必要 user 身份 token 有效。
- [ ] 白名单用户 ID 由当前应用解析。
- [ ] 凭证未进入仓库和日志。

### 18.2 事件驱动

- [ ] 监听器出现真实 ready 标志。
- [ ] 白名单文本消息会入队；非需求不贴表情，需求分类后才添加 OnIt。
- [ ] 无消息时不启动 Codex worker。
- [ ] 同一消息重复投递只处理一次。
- [ ] 持续权限错误会进入 blocked/quarantine，不会每分钟或每次循环重复唤醒 Codex。
- [ ] 修复权限或收到用户恢复指令后，可以对原 `message_id` 安全重试一次。
- [ ] 停止监听器能够优雅退出。
- [ ] 已安装当前助手独占的 Windows 登录自启与 watchdog 任务，最近结果为 `0x0`；任务健康时可处于 `Ready`。
- [ ] watchdog 动作为 `wscript.exe //B //NoLogo run-bridge-watchdog-hidden.vbs`，内部隐藏调用 `ensure-bridge-running.ps1`；健康时只检查本地进程并立即退出，不直接长期托管 Node，且桌面无 CMD/PowerShell 闪窗。
- [ ] 当前 PID 对应独立 Node 进程存在，命令行指向当前项目，日志包含本次启动的 `[event] ready`。
- [ ] 手动结束监听器后，watchdog 能在下一次检查中重新拉起；健康检查没有产生 Codex worker。
- [ ] 从手动进程切换到自启任务前没有活动中的 Codex worker；如有则等待完成后再切换。
- [ ] 锁屏后监听仍保持；睡眠期间不宣称可用，恢复联网后能够重新连接。
- [ ] 无飞书消息时不会周期性唤醒 Codex worker。

### 18.3 回复与媒体

- [ ] 文字回复遵循共同角色正文，不恢复旧固定前缀。
- [ ] 图片可下载并在 Codex 中视觉检查。
- [ ] PNG/JPG 等图片使用 `--image` 发送，并能在飞书对话框中直接预览。
- [ ] HTML/PDF/Markdown/报告使用 `--file` 发送，并能作为文件附件下载。
- [ ] 图片与普通文件均实际送达飞书，而非只给本机路径。
- [ ] 需求全部发送成功后才出现 DONE 和 processed；日常只有已回读回复与 processed。
- [ ] 故意制造附件失败时，消息仍保持 pending。

### 18.4 项目与 Skills

- [ ] 白名单外项目不能访问。
- [ ] 白名单项目调用前读取其规则、Mistakes 和 Skill。
- [ ] 能力卡展示实时授权 Skill 快照和权限边界。
- [ ] Skill 自身确认门禁未被全局授权绕过。

### 18.5 每日通报

- [ ] 计划任务时间和时区正确。
- [ ] 周末和节假日策略符合使用者确认。
- [ ] 缺少年度节假日配置时停止发送。
- [ ] 有数据和无数据两条路径均按配置验收。
- [ ] 同一天重复运行不会重复发送。
- [ ] 卡片视觉符合绿色关怀基线，异常仅局部红/橙强调。

### 18.6 Card 视觉

- [ ] 能力介绍使用蓝色 Card 2.0 两列分组卡。
- [ ] 每日通报使用绿色 Card 2.0。
- [ ] 完成 P0–P7 自检。
- [ ] 卡片内容在飞书客户端真实查看通过；接口成功不能替代视觉验收。

## 19. 部署完成交付物

部署 Agent 必须交付：

1. 助手项目目录。
2. 已脱敏的配置模板和本机实际配置位置说明。
3. 飞书应用/profile 验证结果。
4. 服务启动、停止、状态命令。
5. 项目与 Skill 白名单清单。
6. 每日通报配置与计划任务状态。
7. 监听器登录自启任务、异常重启策略和当前运行状态。
8. 一次真实文本消息端到端验收记录。
9. 一次真实图片消息端到端验收记录。
10. 能力介绍卡和每日通报卡的飞书实机截图或明确的待验收说明。
11. 当前权限边界与仍需使用者确认的事项。

## 20. 给其他使用者的部署提示词

```text
请按《飞书—Codex 个人小助手部署规范》为我部署一个飞书小助手。

部署前请向我确认：
1. 机器人名称、回复前缀和称呼方式；
2. 允许对话的用户/群与消息类型；
3. 是否启用每日定点通报，以及时间、数据源、目标会话、节假日和空数据策略；
4. 允许访问的本地项目、读写范围和确认门禁；
5. 允许调用的 Skill 根目录或 Skill 清单；
6. 排期文档/Base、字段口径和负责人解析方式；
7. 其他自定义能力、语气和视觉要求。

采用事件驱动唤醒，不使用每分钟 Codex 轮询。为监听器安装当前 Windows 用户登录自启与纯本地 watchdog；watchdog 每分钟只检查进程，健康时立即退出，不读取队列、不唤醒 Codex、不调用模型。锁屏可继续运行，睡眠、关机或尚未登录时不宣称在线。收到合格消息先分类，仅需求贴 OnIt，回复及全部附件完成后贴 DONE 再 mark；非需求回复回读后直接 mark，不贴表情。能力介绍与每日通报的 Card 2.0 视觉沿用“牛马小助手”当前蓝色能力卡和绿色关怀通报卡。所有跨项目与飞书写入遵守目标项目和 Skill 自身门禁，任何凭证不得写入仓库或日志。
```

## 21. 参考实现映射

| 规范能力 | botCow 当前实现 |
|---|---|
| 事件监听 | `scripts/lark-event-listener.mjs` |
| Codex 唤醒与轮换 | `scripts/codex-event-wakeup.mjs` |
| 队列与完成账本 | `scripts/bridge-queue.mjs` |
| OnIt / DONE | `scripts/bridge-reaction.mjs` |
| 图片下载 | `scripts/fetch-message-images.mjs` |
| 每日通报 runner | `scripts/run-daily-overdue-alert.mjs` |
| 通报 Card | `scripts/build-overdue-alert-card.mjs` |
| Card 回复 | `scripts/reply-card.mjs` |
| 服务管理 | `scripts/start-bridge.ps1`、`status-bridge.ps1`、`stop-bridge.ps1` |
| 监听器登录自启 | `scripts/install-bridge-autostart-task.ps1`、`scripts/run-bridge-watchdog-hidden.vbs`、`scripts/ensure-bridge-running.ps1`、`scripts/start-bridge.ps1`、`scripts/uninstall-bridge-autostart-task.ps1` |
| 每日通报计划任务 | `scripts/install-overdue-alert-task.ps1` |
| 对话配置 | `config/bridge.json` |
| 业务与通报配置 | `config/assistant-workflows.json` |
| 能力视觉基线 | `runtime/cards/capabilities-overview.json` |

新部署可以复用结构和流程，但必须重新生成自己的应用、profile、白名单 ID、chat_id、项目/Skill 授权和通报配置。
