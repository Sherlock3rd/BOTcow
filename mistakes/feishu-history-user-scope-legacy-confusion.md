# 用户身份历史消息权限不能选历史版本应用权限

日期：2026-11-13。

## 现象

CLI 的 chat-messages-list 预检要求群消息、私聊消息及表情的用户读取权限；获得这些scope后，底层GET /im/v1/messages仍返回99991679。错误同时列出历史版本、只读和读写三项候选。

## 原因与修正

- 助手未先核对身份差异，选择了im:message.history:readonly。该项属于历史版本应用身份权限，不能据此补齐当前用户身份查询。授权页显示“当前无需开通或授权任何权限”，用户token未增加该scope，领取失败。
- 官方接口说明明确：用户身份必须具备im:message:readonly或im:message之一，再按会话类型补充im:message.p2p_msg:get_as_user或群聊对应项。只读任务应选择im:message:readonly，不申请im:message写权限。
- 改为补充im:message:readonly，并在领取后用真实接口验收；不以网页状态或CLI预检代替接口成功。

## 防呆

- 错误列出多个可选scope时，先核对当前身份与官方权限说明，不能把“历史消息”字面最匹配当成适用性。
- 保留安全诊断字段：进程退出码、错误type/subtype/code；不写设备码、授权链接、token或CLI原始响应到日志。
- 私聊风格分析中，Markdown只使用匿名代称，不记录真实人名。

来源：https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/list
