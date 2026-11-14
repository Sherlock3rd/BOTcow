# 飞书词典只读知识源

目标来自管理员在单聊中发送的“词典”卡片。卡片实际指向飞书 Lingo 词库 `EXAMPLE_REPOSITORY_ID`。botCow 只按需读取词条名、别名、释义和相关文档/链接，不复制全库，不修改词条，不读取或输出创建者、联系人、群等成员标识。

```powershell
node scripts/lingo-knowledge.mjs status
node scripts/lingo-knowledge.mjs search --query 'FTE' --limit 5
```

处理术语解释、缩写消歧或策划任务中不确定的企业专属用词时，先运行 `status`；仅当 `ok=true` 时搜索。搜索结果是实时资料，不自动成为长期记忆，也不授权后续文档、配置或消息写入。没有命中时说明未查到，不能用模型猜测企业内部含义。

飞书侧最小权限为 `baike:entity:readonly`。当前调用使用 `botCow` profile 的用户身份，以沿用当前用户对目标词库的可见范围；公开群访客通道仍禁用工具，不可借此查询。若返回 `lingo_read_permission_missing`，需先在开发者后台为“牛马小助手”启用该只读权限，再对用户身份做一次最小增量授权。权限与目标词库均以 `status` 实际回读为准。

验证要求：`status` 回读目标词库 ID 与名称；至少一次 `search` 返回合法合同。未通过前只能称“本地入口已配置，飞书权限待开通”，不得称已接通。
