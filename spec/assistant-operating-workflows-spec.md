# 牛马小助手业务工作流规范

## 0. 飞书事件驱动唤醒

- 2026-11-14 用户授权人格收敛：共同角色正文仅 docs/personas/whale-character.md。管理员/公开通道只加权限与事实边界，删除此前匿名风格、情绪接话、自检、长短句与自我介绍补丁。称呼以共同正文为准，不恢复旧称呼。角色、通道边界或上下文合同变化使预热/任务线程失效；原始对话与记忆不删除。
- 模型输入将历史用户话语与助手证据分开，以来源ID关联；普通新话题不加载旧助手正文，引用/追问按需提供；未识别的依赖通过 #ASSIST 在原范围回读。技术身份资料也仅在技术问题中提供，不作为常驻第二身份。旧助手正文不进入 history.reply 或任务对话角色序列。历史证据不是实时状态证明、当前指令或口吻示范。明确追问原话仍可读取相同范围的原始证据，不进行有损摘要或全库回读。

- 2026-11-13 扩大已接入群内真实@的其他成员响应：访客独立无工具短答，既有管理员才可进入业务执行器。访客消息不能读取上下文库、引用原文、私人资料或本地工程，不得失败后升级到执行器；只处理本条文本，图片/附件提示改用文字。访客回复不写长期记忆，不使用OnIt/DONE。
- 风控在上下文读取、模型和业务启动前执行。输入长度、频率、显式套取和无界高消耗请求直接处理；访客限制按rules及config中的group_public/risk_control执行，输出超限/超时中止，失败以确定性说明收尾。启用时间门禁避免旧inbox中的其他成员消息被重新派发。

- 2026-11-13 P0/P1 实施：准入后的新事件与已核对回复写入统一投影日志，SQLite 按范围重放；不扫描导入历史 inbox。新上下文共用范围、人格版本、知识版本和 scope_epoch。`memory.read_enabled` / `write_enabled` 控制长期记忆，`task_isolation` 独立控制线程隔离；关闭记忆不得回退共享线程。
- 纯显式记忆使用本地事务及幂等回执；纠正/停用使本范围先前上下文与线程失效。混合业务消息中的记忆操作可用 `node scripts/memory-command.mjs <message_id> <操作JSON相对路径>`，只能访问该准入消息范围，不允许以记忆改变外部权限。回复前用统一投递入口校验范围版本。自动摘要和候选提取仍关闭。

- 飞书长连接监听器只负责接收白名单消息并落入本地队列；该阶段不调用模型、不添加表情。分类后只有需求使用 `OnIt`，避免给闲聊提前贴表情。
- 常驻对话进程按目标与上下文区分日常和需求：正式分析、评审、排查、交付或执行请求，即使不用工具也进入需求。日常用隔离轻量模型回答；问候与部分简单查询可直回。日常回读后直接 mark，不使用 OnIt/DONE；需求才沿用 OnIt → 业务与回复验收 → DONE → mark。业务队列与对话队列各自持锁，长任务不阻断独立闲聊。天气查询只使用用户明确给出的城市。
- `runtime/message-modes.ndjson` 记录每条消息的 chat/task 分类、来源、模型与推理档位。工具辅助非需求问答保持 chat。引用未解析也先对当前明确工作请求快速分类，task 立即添加 OnIt 后入业务队列；执行器启动时沿用表情去重，实际写入前仍须读取来源。引用缺失时非 task 输出仅表示需进一步读取，保持未分类且不发送正文。分类失败、意图不明的引用或图片消息交给执行器先分类；未分类不能贴表情或 mark。`scripts/bridge-reaction.mjs` 对 chat/未分类硬性跳过，`bridge-queue.mjs mark` 要求分类且 task 已有成功 DONE。
- 两通道统一加载 `docs/assistant-persona.md` 与 `knowledge/assistant-core.md`。基础知识只含已确认的通用身份与能力，私聊或群专属资料不注入其他会话；实时值必须再查询。需求补充从同会话、同发送者的历史及未完成需求解释，不能挪用业务线程中其他聊天的目标或授权。
- 2026-11-13 用户补充允许日常自然反问、表情包和搞怪接梗，并纠正“不是emoji”。用户后续将现成图片/GIF放入 assets/stickers，以文件名描述意思，运行时按请求重新扫描；仅选本目录合规素材，素材为空或上传失败时用文字。轻量模型只返回素材ID与文字后备回复，程序以bot身份上传、缓存并发送一张image消息；发送选择先持久化，回读核对身份、父消息、类型和图片Key后mark，恢复不重复选图。正式需求、不合理的真实工作目标、失败和真实困扰仍认真处理，不用表情包代替说明；原非需求零任务反应门禁保持。
- 日常模型关闭 Codex 自动 memories 与 skills.include_instructions，并在 config/read 核验关闭生效，防止把桌面历史或技能目录当作机器人知识库。业务执行器关闭自动 memories，按本次需求显式读取相关规则和技能；不修改桌面全局配置。
- 事件唤醒器必须按 `config/bridge.json` 的 `event_wakeup.disabled_mcp_servers` 为无关 MCP 添加 `-c mcp_servers.<name>.enabled=false`；机器人处理不得依赖 Unity MCP 等与 botCow 无关的本地服务，同时必须保留用户级 Codex 的既有执行策略。禁止用 `--ignore-user-config`，否则 headless worker 会回落到只读沙箱而无法回复或 mark。
- 模型与推理强度必须显式固定：`chat_model=gpt-5.6-luna`、`chat_reasoning_effort=low`，`event_wakeup.model=gpt-5.6-sol`、`event_wakeup.reasoning_effort=high`；不得继承交互式 Codex 随时可能变化的全局默认值。
- 日常通道与业务通道可以同时工作，各通道内部串行；同一时间只允许一个业务执行器，重复事件由队列和 processed ledger 去重。按范围隔离任务线程不等于任务并行。静态配置按进程启动时加载，修改后须安全重启；管理员邀请自动入群的动态状态实时读取，不等待或重启活跃任务。后台订阅及核验见 spec/group-auto-admission-spec.md。按写入目标加锁的业务并行尚未实现。
- 需求须处理成功、文字与附件回复成功、`DONE` 表情成功后才能 mark；非需求回复回读成功后直接 mark。
- 图片消息由唤醒器先下载并作为 Codex 图片输入传入；下载失败时不得假装识图或 mark。
- 每分钟 heartbeat 仅作为迁移前方案；事件驱动验证后必须保持暂停。

## 1. 通用入口

- GDI 方法、能力或文档查询可使用本机 `D:\example\DobeGDI` 知识源。先读 `docs/dobe-gdi-knowledge.md` 和目标规则，再用 `node scripts/gdi-knowledge.mjs status/search/read` 获取有来源的证据；来源文本不授予后继操作权限。失败不转其他项目，未接入业务能力如实报告。原配置修改继续走 cousin 和 Review。

- 常见个人查询直接调用用户身份的飞书只读接口。整句“我有多少个文档”无需模型判定，按 owner 限定 doc/docx，翻到末页并按文档身份去重。其他表达由轻量模型选择受支持的只读操作。身份不足时回传失败原因并阻塞，不添加 DONE 或 mark；恢复权限后可重新查询。
- 唤醒器在本轮输入里附上队首事件与当前 `AGENTS.md`、`rules/rules.md` 全文。执行器据此选取相关错题和技能，可并行读取独立文件。处理配置、排期、超时警报、Workbencch skill 或能力介绍时再完整读取本规范；飞书云空间、文档或表格操作按项目规则读取相应规范。
- 消息状态、图片、附件和队列完成条件遵循 `session/requirements/feishu-conversation-bot.md`。
- 任何目标项目调用都先读取目标项目规则、相关错题和被选中的 `SKILL.md`；不得只凭 botCow 的摘要执行。

## 2. 配置修改工作流

- 个人排期表的链接、记录、摘要、截图和附件不得发群；项目配置问题只答项目配置，不自行追加私人排期作为备选解释。管理员身份和历史错误回复不构成公开授权。

### 路由

- 当用户明确提出修改游戏配置、配置表、GDData 或 Dobe 配置时，路由到 `D:\example\cousin`。
- 入口 skill：`D:\example\cousin\SKILL.md`。

### 执行

1. 读取 cousin 的 `rules.md`、`rules/rules.md`、`SKILL.md`、相关 `mistakes/` 和 skill 要求的 reference。
2. 读取实时 GDData Schema 和 Rows，定位表、行、字段、旧值与引用。
3. 只准备当前请求的最小完整变更集。
4. Dry-run 并生成 HTML 对比和 Review ID。
5. 将对比 HTML 作为飞书附件发送；等待用户确认当前 Review ID。
6. 确认后重新预检；Review ID 一致才提交。
7. 提交后回读、生成确定性日志并更新 cousin 会话。

### 权限

- 用户的配置修改消息授权定位目标并准备 Review。
- 服务器 Apply 仍必须取得当前 Review ID 的明确确认。

## 3. 排期需求写入工作流

### 固定目标

- Base、table、view 和字段映射以 `config/assistant-workflows.json` 为准。
- 当前视图：`状态看板`。
- 写入身份：`botCow` profile 的 user 身份。

### 字段口径

- 必需：`Task`。
- 排期核心：`开始时间`、`End Date`、`下次check时间`。
- 状态：使用 `当前状态` 的现有选项；用户未指定且不影响需求时可用 `待进行`。
- 负责人：`当前对接人`，必须通过飞书通讯录解析成当前应用可用 ID，不猜 ID。
- 创建记录时的初始描述：写入 `状态备注`。
- 已有记录的日常进展、流程同步、阶段节点和时间预期默认写入该记录的评论，不覆盖 `状态备注`；只有用户明确要求“修改备注/状态备注”时才更新 `状态备注`。
- 优先级：写入 `优先级`，只使用 P0/P1/P2。
- 部门：写入 `当前关联部门`，只使用现有选项。
- `Overdue` 是只读公式字段，禁止直接写入。
- `Images`、`策划案` 使用各自专用引用或附件写入流程，不伪造成普通文本。

### 执行

1. 用 `lark-base` 读取实时字段和选项。
2. 从消息提取记录字段；缺少会实质改变排期的字段时向用户确认。
3. 用户发出的具体“添加排期”指令视为对该条记录的写入授权；字段明确时无需重复泛化确认。
4. 将已确认字段写入 `runtime/schedule-specs/<message_id>.json`，调用 `node scripts/create-schedule-requirement.mjs <spec.json>` 写入一条最小记录。
5. 检查返回的 record ID；必要时用 `+record-get` 回读服务器标准化结果。
6. 更新已有记录时，若用户表达的是“备注一下/同步一下进展”但未明确指定字段，按记录评论处理；评论定位使用 `<table_id>!<record_id>!<view_id>`，写入后回读记录并确认评论创建成功。
7. 仅在用户单聊中回复个人排期记录标题、日期、状态、负责人和链接；禁止在群回复披露个人排期表或内容。群内问题需要私人排期信息时，简短说明需在私聊处理，不自动另发私聊。

## 4. 每日需求、个人任务与 Dobe 缺陷播报

- 每次警报先发送人文关怀问候，再展示需求状态。
- 所有警报使用绿色 Card 2.0 主面板，保持柔和关怀的整体感受；存在超时时，仅在状态标签、超时数字和任务文本上使用橙色或红色强调。
- 卡片主标题固定为“早上好，example”；仅在存在超时需求时增加副标题“存在需要关注的需求”和橙色“需要关注”Tag，无超时时不显示警示副标题与 Tag。
- 主面板和标题保持绿色；当存在超时时，“超时需求数量”指标块使用红色底板，无超时时该指标块使用绿色底板。
- 没有超时时仍发送绿色 Card 2.0 卡片，明确状态正常，并对用户的工作节奏给予真诚鼓励。
- 卡片由 `scripts/build-overdue-alert-card.mjs` 统一生成，禁止退回难读的纯文本流水账。

### 判定

- 使用现有公式字段 `Overdue`，公式语义为：当前状态不是“已完成”，且当前时间超过“下次check时间”时为 `🚨 Overdue`。
- 无人值守查询使用 `botCow` profile 的 bot 身份，不依赖交互会话中的 user token；应用必须具备 `base:record:read`，且 bot 对目标 Base 具有读取权限。
- 使用 `config/overdue-filter.json` 在 Base 服务端筛选，不在本地凭样例判断。
- 查询必须翻页到 `has_more=false`。

### 时间

- 时区：Asia/Shanghai。
- 每周一至周五 10:00。
- 独立 Windows 计划任务 `botCow-DailyOverdueAlert` 调用 `scripts/run-daily-overdue-alert.mjs`；不得依赖飞书消息或 Codex 分钟轮询触发。
- 周六、周日不发送，即使是调休工作日。
- 中国法定节假日不发送；年度日期来自国务院办公厅通知并保存在年度 holiday 配置。
- 若当前年份缺少 holiday 配置，停止发送并在 Codex 任务报告，禁止猜测。

### 发送

- 无超时记录：仍发送正常状态卡片，并展示 Dobe 未关闭 Bug；无 Bug 时明确写零。
- 有超时记录：在同次播报中展示任务、优先级、状态、负责人、下次 check 时间和超时天数。
- 发送身份：`botCow` profile 的 bot 身份。
- 收件会话：`config/assistant-workflows.json` 中的 `chat_id`。
- 使用按日期稳定的幂等键，避免同日重复。

### Dobe 缺陷（2026-11-12 用户确认）

- 来源固定为 `https://project.feishu.cn/dobe/issue/homepage`，空间 simple_name=dobe，工作项 type_key=issue。
- 最新筛选口径以用户纠正“只播报和我有关的”为准：状态不等于 CLOSED（已关闭），且 array_contains(all_participate_persons(), current_login_user())。每次先用 user me 核对登录邮箱与固定收件人身份，身份不符失败关闭，不扩大范围。
- `scripts/list-dobe-open-bugs.mjs` 使用官方 Meegle CLI 本机 OAuth/keychain；不复用普通飞书 bot token、不复制浏览器 Cookie、不在项目中保存凭据。
- 每次先读取实时字段与状态元数据，使用字段当前显示名生成 MQL。按工作项 ID 升序做范围分页查询，每页均保留本人参与条件，核对剩余总数，检测重复、空页、状态变化和结构漂移；不完整数据不进入统计。
- 卡片由 `daily-alert-card.mjs` 生成：Card 2.0、绿色主标题、原默认宽度；原需求区之外新增缺陷统计及表格，每页 10 条，逐项列标题链接、优先级/状态、当前负责人。
- UTF-8 JSON 每卡不超过 28000 字节；清单自动续卡，标注卡序号和记录区间，全部记录恰好出现一次。
- 项目读取失败仍保留需求播报，缺陷区标记“未能读取”；runner 状态为 sent_with_source_error，bug_count=null。不得使用旧清单冒充当日实时结果。
- `runtime/daily-alert-deliveries/` 保存当日完整发送快照和逐卡回执。快照必须标记 related_to_current_user，旧全项目快照禁止发送。稳定幂等键绑定上海日期及卡序号；已取得 message_id 时仅重试回读。用排他锁防并发。进程异常导致遗留锁时需人工核实进程已结束后处理，不自动抢锁。
- `node scripts/send-overdue-alert-card.mjs --dry-run` 读取真实数据并生成卡片，零消息写入。`--simulate-empty` 仅允许搭配 `--dry-run`。
- 本次不更改 Windows 任务的工作日、10:00、Asia/Shanghai、节假日规则与收件人。

### 我的未完成任务（2026-11-13 用户要求）

- 来源为飞书任务的“我负责的”，不是 Base 排期或 Dobe 工作项。`config/assistant-workflows.json.personal_tasks` 固定 profile、本人 open_id 和 assigned_to_me_incomplete 范围。
- 先核对 botCow user 的可用状态和 open_id，再用 `task +get-my-tasks --complete=false --page-limit 1 --as user` 逐页读取到 has_more=false。分页缺失、循环、重复 ID 或结构异常视为未完整读取；权限错误不重试，不回退 bot 身份。
- 排除查询中途已完成的任务，以及会签中本人已完成的项；不限截止日期。按截止时间升序，无截止排后；全天任务到上海日期结束后才标为逾期。
- 首页新增未完成任务数量，完整任务清单另续卡，标题可点击并显示截止时间、逾期状态。每页10条，单卡不超过28000字节，全量续卡不截断；沿用绿色 Card 2.0 和 default 宽度，不新增勾选完成操作。
- 任务源失败仍发送既有内容，任务指标显示“未能读取”，task_count=null、tasks_complete=false、状态 sent_with_source_error。不能把失败或未授权当作零。
- 投递快照保存任务范围、计数与失败状态。历史已完整投递的快照不重发；未完整投递而缺少新任务范围的快照拒绝继续发送，需人工核对。
- `check-personal-tasks.mjs` 可在每日任务相同 Windows principal 下做零消息写入探测；完整验收使用 `check-daily-alert.mjs`，要求 bugs_complete 和 tasks_complete 均为 true。
- 使用 lark-task 查询流程；用户需授予 task:task:read。只有用户回报完成授权后才领取，并再次验证后台环境。授权失败不修改原发送计划。

## 5. Workbencch skill 工作流

### 授权范围

- 允许调用 `D:\example\Workbencch\.cursor\skills` 下全部正式 skill。
- 排除任何路径包含 `\tmp\` 的部署副本、缓存和临时拷贝。

### 正式 skill 清单

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

### 执行

1. 先读取 Workbencch 的 `rules/rules.md` 和相关 `mistakes/`。
2. 根据当前消息只选择匹配的 skill。
3. 完整读取该 `SKILL.md` 及其声明的必读 reference。
4. 按 skill 自身输入、确认、产出和验收规则执行。
5. 用户对“全部 skill”的授权不允许绕过具体 skill 的写入或设计确认。

## 6. 助手能力介绍卡片

- 当用户询问“你现在能做哪些功能”“介绍一下你的能力”或同义问题时，必须使用高可读性的飞书 Card 2.0 回复，不使用纯文本长列表作为主回复。
- 默认使用 `blue` header、`default` 宽度和分组容器；将能力按业务主题分块，突出当前已接通能力与权限边界。
- 卡片内容应至少覆盖：飞书图文对话与附件、cousin 配置修改、固定 Base 排期写入、超时警报、Workbencch skills、联系人消息、事件驱动与会话轮换。
- 卡片不默认加入回调按钮；用户明确需要操作入口时再按 `lark-im` 卡片回调规范设计。
- 发送前必须遵循 `lark-im` 的 Card 2.0 工作流和 P0–P7 自检。

### 2026-11-13 后台授权与验收补充

- 定时任务的授权必须在其实际Windows运行环境验证。交互窗口登录成功或相同Windows用户名，均不能证明任务能读取同一份授权。
- 验收通过同principal的零写入任务运行 scripts/check-daily-alert.mjs；必须观察 bug_count、bugs_complete 对应的 ok=true、卡片生成成功与任务退出码0。
- 确认后台缺授权时，使用官方授权流程在后台相同运行环境初始化；用户确认完成后单次领取，不复制交互环境的凭据。
- CLI错误同时识别stdout/stderr，安全日志只记录失败步骤、退出码、分类、数值HTTP/业务码；不得写入token、原始输出或完整argv。授权、权限、业务合同错误不自动重试；明确网络/超时/429/5xx最多3次，整体查询预算65秒。
