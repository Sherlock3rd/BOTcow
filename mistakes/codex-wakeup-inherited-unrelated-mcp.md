# 事件唤醒器继承无关 MCP 导致消息积压

## 现象

- 飞书长连接正常，消息已经入队并添加 `OnIt`，但没有回复、`DONE` 或 mark。
- `codex-event-wakeup.log` 持续出现连接无关本地 MCP 地址失败，Codex 以退出码 1 结束并重试。

## 原因

- 自动化 worker 默认读取用户级 `config.toml`。
- 用户日常 Codex 配置中存在只在特定项目或应用开启时可用的本地 MCP；该服务离线会让 botCow 的独立 Codex 启动失败。

## 修复

- 在 `config/bridge.json` 配置 `event_wakeup.disabled_mcp_servers`，唤醒命令为每项追加 `-c mcp_servers.<name>.enabled=false`。
- 只关闭与 botCow 无关的 MCP，保留用户级 Codex 的登录态和 headless 执行策略。
- 禁止使用 `--ignore-user-config`：实测会让 worker 回落到只读沙箱，能诊断但无法运行队列和飞书回复命令。

## 防呆检查

1. 部署测试必须在无关本地 MCP 全部关闭的情况下完成一次真实消息闭环。
2. 验收 `pending -> OnIt -> reply -> DONE -> mark`，不能只检查监听器进程存活。
3. 若队列积压，分别检查监听状态和 `codex-wakeup-status.json`，不要把执行器失败误判为飞书断线。
4. 在 bridge 配置中固定 worker 模型；升级模型前先验证后台 Codex CLI 支持，禁止继承全局默认模型。

## 同日发现：计划任务看不到用户授权

- 交互终端的 `botCow` user 身份为 `valid`，但每日计划任务仍返回 `token_missing`。
- 把 principal 从短用户名改为完整 `DOMAIN\\username` 后复测仍失败，因此用户名形式不是根因，禁止把该改法记录为修复。
- 无人值守的每日 Base 查询不应依赖只在交互会话可读的 user 凭据；候选修复是改用 bot 身份，但必须先取得 `base:record:read` 应用权限和目标 Base 访问权，并按权限变更门禁获得用户确认。
