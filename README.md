# botCow

Windows 本机运行的飞书—Codex 机器人：事件驱动收件，日常与业务双通道，按会话隔离的显式记忆和任务线程。

- 管理员单聊与群内真实 @；群访客仅限无工具短答。
- 管理员邀请机器人入群即授权接入，动态准入无需重启；依赖飞书后台订阅入群和移出事件。
- 日常回复回读后完成；需求使用 OnIt → 执行与回复验收 → DONE → 完成账本。
- 日常与业务可以同时运行，业务任务之间仍串行。没有多个业务任务并行。
- 独立 Windows watchdog 与每日通报任务；空闲不轮询模型。

## 部署

完整步骤与验收见 [部署规范](spec/feishu-codex-personal-assistant-deployment-spec.md)、[自动入群](spec/group-auto-admission-spec.md) 和 [发布边界](spec/repository-publication-spec.md)。

需要 Windows、Node.js `>=22.17.1 <23`、已登录的 Codex CLI、`@larksuite/cli` 和本人的飞书自建应用。模型名称来自参考部署，须核对自己账号的可用模型并显式配置推理档位。

```powershell
npm install -g @larksuite/cli
node --version
codex --version
lark-cli --version

# 仅在首次部署且目标文件不存在时复制，不能覆盖现有配置
Copy-Item config/bridge.example.json config/bridge.json
Copy-Item config/assistant-workflows.example.json config/assistant-workflows.json
Copy-Item config/lingo-knowledge.example.json config/lingo-knowledge.json
Copy-Item config/contact-aliases.example.json config/contact-aliases.json
```

部署前填写本应用解析的管理员 open_id、bot open_id、profile 和 app_id；确认规则中的业务目标。示例配置默认禁用事件唤醒、访客及自动入群，完成授权与检查后再启用。自动入群需设置启用时间，并在飞书“事件与回调”订阅：

```text
im.message.receive_v1
im.chat.member.bot.added_v1
im.chat.member.bot.deleted_v1
```

成员事件使用 bot 权限 `im:chat.members:bot_access`。后台未订阅时会记录 blocked，现有消息监听继续运行；修复后安全重启监听器。查看 `runtime/im.chat.member.bot.*.status.json`，再用真实邀请与真实 @ 回复验证。

```powershell
npm run bridge:start
npm run bridge:status
node scripts/bridge-queue.mjs pending
```

生产升级或静态配置变更须等待处理锁和 pending 清空，再优雅停止、更新、启动；不得中断活跃业务。登录自启见 `scripts/install-bridge-autostart-task.ps1`。

可选业务适配器并非开箱即用：Base 字段与目标、Meegle 空间及本人身份、词库 ID、当地节假日、本地项目/Skill 路径都须由部署者核对。GDI 通过 `GDI_KNOWLEDGE_ENTRY` 指定外部只读入口；Meegle 授权辅助脚本通过 `MEEGLE_PLUGIN_SCRIPTS` 指定已安装的官方组件目录。每日通报还保留参考项目的卡片与缺陷链接合同，迁移到其他项目需同步适配和测试后才安装计划任务。

## 验证与资料

```powershell
npm test
# 可选：已安装并获准访问外部 GDI 时执行真实本机集成
$env:BOTCOW_GDI_INTEGRATION = '1'
node --test scripts/gdi-knowledge.test.mjs
Remove-Item Env:BOTCOW_GDI_INTEGRATION
```

普通回归使用模拟服务和临时目录，不发送飞书测试消息；`check-*` 的模型/外部集成探测须另外阅读脚本与权限要求。通过测试不等于真实账号授权或端到端成功。

公开仓库不包含真实配置、运行日志、聊天/记忆数据库、二维码或授权凭据。人格来源与独立 MIT 许可见 [来源说明](docs/personas/whale-source.md)；该许可不代表整个项目已采用相同许可。
