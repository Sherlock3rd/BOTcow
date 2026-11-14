// Explicit live model check only: synthetic input, no Feishu calls or business execution.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChatModel } from "./chat-model.mjs";

if (!process.argv.includes("--live")) throw new Error("pass --live to run synthetic model checks (no Feishu writes)");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(readFileSync(join(root, "config/bridge.json"), "utf8"));
const candidate = join(process.env.APPDATA || "", "npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe");
const executable = process.env.BOTCOW_CODEX_EXE || (existsSync(candidate) ? candidate : "codex");
const runtime = join(root, "runtime/chat-routing-check");
mkdirSync(runtime, { recursive: true });
const task = { message_id: "synthetic", mode: "task", status: "pending", user: "评审战斗系统的资源循环", reply: null };
const cases = [
  { name: "casual", question: "今天有点累，只想聊聊。", expected: "answer" },
  { name: "identity", question: "你是谁，有什么性格？你的知识库里有什么？", expected: "answer" },
  { name: "analysis_without_tools", question: "请深入评审一个体力系统：每小时恢复10点、一次关卡消耗6点、每天希望玩家打30关，分析矛盾并给出调整方案，不需要查资料或修改文件。", expected: "task" },
  { name: "greeting_with_task", question: "你好，帮我把刚才的设计整理成需求文档。", expected: "task" },
  { name: "missing_quote_task", question: "@牛马小助手 记录到文档", missingReference: true, expected: "task" },
  { name: "missing_quote_ambiguous", question: "@牛马小助手 这个呢", missingReference: true, expected: "assist" },
  { name: "task_followup", question: "继续刚才的评审", activeTasks: [task], expected: "task" },
  { name: "independent_chat", question: "工作先放一边，讲个轻松的笑话吧。", activeTasks: [task], expected: "answer" },
  { name: "quoted_chat", question: "换一种说法", quoted: { mode: "chat", status: "completed", user: "今天有点累", reply: "先休息片刻也挺好。" }, expected: "answer" },
  { name: "tool_question", question: "今天的科技新闻有什么？随便聊聊，帮我查一下实时新闻就好。", expected: "assist" },
  { name: "simple_read", question: "我今天日程是什么？", expected: "read" },
  { name: "memory_save", question: "请帮我记住，我希望方案先给结论", expected: "memory" },
  { name: "memory_list", question: "你记得我对方案格式有什么要求吗？", expected: "memory" },
  { name: "memory_correct", question: "把那条格式偏好改成复杂方案先解释背景", expected: "memory" },
  { name: "memory_forget", question: "请忘掉那个格式偏好", expected: "memory" },
  { name: "memory_mixed", question: "记住这个口径，再把表改了", expected: "task" },
  { name: "memory_emotion", question: "我今天有点累，陪我随便聊聊", expected: "answer" },
  { name: "memory_unavailable", question: "我们上周约定了哪个提交目标？", unavailable:true, expected: ["answer","memory"] },
].filter(entry => (!process.env.BOTCOW_CHECK_CASE || entry.name === process.env.BOTCOW_CHECK_CASE) &&
  (!process.argv.includes("--memory") || entry.name.startsWith("memory_")));
let model = new ChatModel(executable, runtime, config.chat_model, config.chat_reasoning_effort);
const results = [];
try {
  for (const entry of cases) {
    const timing = {}, started = Date.now();
    let answer;
    try {
      answer = await model.answer({ schema_version:1,memory_status:entry.unavailable?"unavailable":"available",
        confirmed_memories:entry.name.startsWith("memory_")&&!entry.unavailable?[{id:"mem_fixture",value:"方案先给结论",revision:1,source_message_id:"synthetic"}]:[],
        question: entry.question, history: [], activeTasks: entry.activeTasks ?? [],
        quoted: entry.quoted ?? null, missingReference: entry.missingReference ?? false,
        now: "2026年11月13日 星期五 16:00" }, timing);
    } catch (error) {
      answer = { kind: "error", error_type: error.name, first_text_ms: timing.first_text_ms ?? null };
      model.close();
      model = new ChatModel(executable, runtime, config.chat_model, config.chat_reasoning_effort);
    }
    const grounded = entry.name !== "identity" || !/审批|FTE|用户偏好|运行排查经验/.test(answer.text || "");
    const result = { name: entry.name, expected: entry.expected, actual: answer.kind,
      ok: (Array.isArray(entry.expected)?entry.expected.includes(answer.kind):entry.expected===answer.kind) && grounded &&
        (!entry.unavailable || (answer.kind==="memory"?answer.command.operation==="list":/无法|不能|不可用|未能/.test(answer.text??""))),
      answer, duration_ms: Date.now() - started };
    results.push(result);
    process.stdout.write(JSON.stringify(result) + "\n");
  }
} finally {
  model.close();
  writeFileSync(join(runtime, "results.json"), JSON.stringify({ model: config.chat_model,
    effort: config.chat_reasoning_effort, writes_attempted: 0, results }, null, 2) + "\n");
}
if (results.some(row => !row.ok)) process.exitCode = 1;
