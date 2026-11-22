# 用量统计

[文档目录](README.zh-CN.md) · [项目首页](../README.zh-CN.md) · [English](usage-stats.md)

打开**设置 → 用量**，选择 Cursor、Codex、Claude 或 Antigravity 页签。默认选中当前配置的 CLI。在同一个设置窗口中，「用量」和「模型」分别记住各自选中的 CLI。

Codex 在同一次请求中批准计划并立即继续执行时，回复的 token 和 API 费用估算包含计划、执行两个阶段。日志读取会识别适配器的计划转执行流程，保留每次模型请求用于计价，并等待执行阶段结束。重启应用后重新打开历史对话，会补回这类回复缺失的用量；从 CLI 同步历史也使用相同的合并统计。旧版导入中已经分开保存的计划和执行结果，修复时继续分别统计。

## 账号额度

Cursor、Codex 和 Antigravity 页签在本机用量上方显示各自的账号额度。Claude 页签直接显示本机用量。Cursor 显示当前账单周期里的 Cursor 模型和其他模型占用，以及下次重置时间；有按需上限时一并显示。Cursor 模型和其他模型还会带上该池的实际 token（输入、输出、缓存读、缓存写）和账号返回的价格，并按账号的池标记拆开。其他模型只显示包含的 API 用量百分比。套餐的包含金额会停在已购上限，不是这一池的消耗，所以不标在这行上。按需支出在进度旁显示已用和上限；账号若返回了按需明细，也会带上 token，但不再重复总价。Codex 显示接口返回的窗口，常见是 5 小时和每周，并写出下次重置时间。Antigravity 通过 `agy -p "/usage" --output-format json` 读取各模型组（如 Gemini 模型、Claude 和 GPT 模型）的 5 小时与每周额度及下次重置时间，并并行读取 `/credits` 显示可用的 AI 积分余额。没有的窗口不显示。只用 API Key 登录的 Codex 和 Antigravity 没有订阅额度，卡片会说明原因。这些数字来自账号接口，不是下面的本机估算。

进入 Cursor、Codex 或 Antigravity 页签时只读取所选 CLI 的额度。点击「刷新」更新当前卡片，读取期间保留上次的数值。Codex 额度与重置卡并行查询，Antigravity 额度与 AI 积分并行查询；Cursor 套餐、token 明细和 Codex 重置卡最多等待 3 秒，Antigravity AI 积分最多等待 10 秒，辅助请求失败不会丢弃已读取的额度。主要额度接口仍最多等待 15 秒（Cursor 首次使用 API Key 时需先交换登录令牌，该步骤也最多等待 15 秒）。

## 本机 token 与费用估算

本机用量默认统计所选 CLI 最近 7 天的回合、token 和费用，并按模型列出明细。也可以选择最近 1 天或 30 天，切换 CLI 时保留所选天数。每一轮按结果记录的 CLI 归属。旧回合缺少 CLI 标记时沿用会话的 CLI，更早的无标记会话归入 Cursor。

下方的会话列表展示所选 CLI 的全部历史，每页 20 条，切换 CLI 时回到第一页。一个会话若用过两个 CLI，会出现在两个页签中，每处只列出该 CLI 对应回合的模型、token 和费用。完全没有用量记录的会话列在会话所属的 CLI 页签，费用显示为「—」。模型使用「Grok 4.7 500K High Fast」这样的短名。

一轮结束时，回复下方也会显示该轮的耗时、token、模型和估算费用。Codex token 根据本机日志的累计用量差统计，包含一轮内的所有模型请求，重复快照只计一次。输入排除缓存，推理 token 已包含在输出中。Codex 逐请求计价，避免多次短请求的累计输入误触发长上下文价格。其他 CLI 使用其报告的回合用量，缓存读取和写入分开计数。Cursor 使用 [Cursor 公开标价](https://cursor.com/docs/models-and-pricing)，Codex 使用 [OpenAI API 公开标价](https://developers.openai.com/api/docs/pricing)，Claude Code 使用 [Anthropic API 公开标价](https://platform.claude.com/docs/en/about-claude/pricing)，Antigravity 使用 [Gemini API 公开标价](https://ai.google.dev/gemini-api/docs/pricing)与 [Google Cloud 合作伙伴模型公开标价](https://cloud.google.com/model-garden/partner-models/pricing)，单位均为美元 / 百万 token。同一模型在不同 CLI 中按各自的价格分别统计。估算金额不代表订阅账单或剩余额度；Cursor 估算不含 Teams Token Rate。不足一美分的金额显示到四位小数。Auto、Orchestrator、没有记录 API 模型的 Claude 别名，以及价目表里没有的模型只显示 token，费用标为未定价。模型选择器和设置里的常用模型在鼠标悬停时显示同一套标价；触摸和触控笔操作不弹出价格提示。展开模型菜单时会隐藏入口按钮的价格提示，避免遮挡选择。Claude Haiku 5.5 在单次请求的输入（含缓存读、缓存写）超过 100,000 token 时，输入、缓存和输出都按 5 倍计费。上面的汇总里，分叉复制过去的一轮只计一次。会话列表按每段对话自己的记录相加，所以同一轮会同时出现在原对话和分叉里。

Codex 费用估算支持 [GPT-6.2 Astra](https://developers.openai.com/api/docs/models/gpt-6.2-astra)、[GPT-6.2 Sol](https://developers.openai.com/api/docs/models/gpt-6.2-sol) 和 [GPT-6.1 Terra](https://developers.openai.com/api/docs/models/gpt-6.1-terra)，以及更早的模型，例如 [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol)。标准费率（美元 / 百万 token）：

| 模型 | 输入 | 缓存读取 | 缓存写入（30 分钟） | 输出 |
| --- | --- | --- | --- | --- |
| GPT-6.2 Astra | $8 | $0.40 | $10 | $40 |
| GPT-6.2 Sol、GPT-6.1 Sol | $2 | $0.10 | $2.50 | $10 |
| GPT-6.1 Terra | $1 | $0.05 | $1.25 | $5 |

Fast 为上述费率的两倍。单次请求的输入（含缓存）超过 272,000 token 时，输入与缓存费率乘以 2，输出费率乘以 1.5；Fast 在长上下文费率上再乘以 2。点号与连字符 id（`gpt-6.2-astra`、`gpt-6-2-astra`）和带日期的快照使用同一组价格。这些数字是 Standard API 标价，不代表 ChatGPT 订阅扣费。

Cursor 对当前 [Cursor 价目](https://cursor.com/docs/models-and-pricing)新增模型的估算使用以下费率（美元 / 百万 token）：

| 模型 | 输入 | 缓存读取 | 缓存写入 | 输出 |
| --- | --- | --- | --- | --- |
| [Claude Fable 5.2](https://cursor.com/docs/models/claude-fable-5-2) | $8 | $0.20 | $10 | $40 |
| [Gemini 4 Carbon](https://cursor.com/docs/models/gemini-4-carbon) | $2 | $0.10 | — | $10 |
| [Gemini 4 Hydrogen](https://cursor.com/docs/models/gemini-4-hydrogen) | $1.50 | $0.075 | — | $7.50 |
| [Gemini 4 Neon](https://cursor.com/docs/models/gemini-4-neon) | $3 | $0.15 | — | $15 |
| [DeepSeek V4.1 Flash 1017](https://cursor.com/docs/models/deepseek-v4-1-flash-1017) | $0.30 | $0.006 | — | $1.20 |

Gemini 4 Carbon 在 2026 年 11 月 30 日前使用介绍价。2026 年 12 月 1 日起为输入 $4、缓存读取 $0.20、输出 $20。连字符 id（如 `claude-fable-5-2`、`deepseek-v4-1-flash-1017`）使用同一组价格。这些数字不含 Teams token 费率。

Claude Code 按用量更新附带的 API 模型 id 计价，并把它记在回复的 `apiModel` 上。`opus` 这类别名本身不计价，所以别名以后指向新模型时，旧回合不会被重新计价。没有记录 API 模型的回合保持未定价。带日期的快照（如 `claude-haiku-4-5-20251001`）使用去掉日期后的价格。缓存写入按 5 分钟费率计算，因为 CLI 把 5 分钟和 1 小时写入合成一个计数。Claude 4.6 及更新版本按标准费率计算完整的 1M 上下文，上下文标记不会改用长上下文价格；Claude Haiku 5.5 除外，超过 100,000 token 的提示按 5 倍计费。Fast、Batch 和仅美国推理没有单独记录，保持未定价。

Antigravity 按 [Gemini API](https://ai.google.dev/gemini-api/docs/pricing)、[Google Cloud Generative AI](https://cloud.google.com/vertex-ai/generative-ai/pricing)（Global Standard）及 [Google Cloud 合作伙伴模型](https://cloud.google.com/model-garden/partner-models/pricing)公开标价估算（美元 / 百万 token）：

| 模型 | 输入 | 缓存读取 | 缓存写入 | 输出 |
| --- | --- | --- | --- | --- |
| Gemini 4 Carbon、Gemini 4 Argon | $2 | $0.10 | — | $10 |
| Gemini 4 Hydrogen | $1.50 | $0.075 | — | $7.50 |
| Gemini 4 Neon | $3 | $0.15 | — | $15 |
| Gemini 3.8 Flash、Gemini 3.7 Flash、Gemini 3.6 Flash | $0.75 | $0.075 | — | $3.75 |
| Gemini 3.5 Flash | $1.50 | $0.15 | — | $9 |
| Gemini 3.5 Flash-Lite、Gemini 2.5 Flash | $0.30 | $0.03 | — | $2.50 |
| Gemini 3.1 Pro（`≤ 200k` / `> 200k`） | $2 / $4 | $0.20 / $0.40 | — | $12 / $18 |
| Gemini 3.1 Flash-Lite | $0.25 | $0.025 | — | $1.50 |
| Gemini 3 Flash | $0.50 | $0.05 | — | $3 |
| Gemini 2.5 Pro（`≤ 200k` / `> 200k`） | $1.25 / $2.50 | $0.125 / $0.25 | — | $10 / $15 |
| Gemini 2.5 Flash-Lite | $0.10 | $0.01 | — | $0.40 |
| Claude Opus 5.5 | $4 | $0.20 | $5 | $20 |
| Claude Sonnet 5.5 | $2 | $0.10 | $2.50 | $10 |
| Claude Opus 4.6 | $5 | $0.50 | $6.25 | $25 |
| Claude Sonnet 4.6 | $3 | $0.30 | $3.75 | $15 |
| GPT-OSS 120B | $0.09 | — | — | $0.36 |
| GPT-OSS 20B | $0.07 | $0.007 | — | $0.25 |

Gemini 4 Carbon 与 Gemini 4 Argon 在 2026 年 11 月 30 日前使用介绍价，2026 年 12 月 1 日起为输入 $4、缓存读取 $0.20、输出 $20。Gemini 3.8 Flash、3.7 Flash、3.6 Flash 在 2026 年 12 月 31 日前使用介绍价，2027 年 1 月 1 日起为输入 $1.50、缓存读取 $0.15、输出 $7.50。Anthropic 合作伙伴模型的缓存写入按 5 分钟费率计算。带思考档位后缀的 ID（如 `gemini-4-carbon-high`、`claude-opus-5-5-max`）以及网关前缀 ID（如 `agy/gemini-4-carbon-high`）使用同一组价格。`Orchestrator (Carbon)` 和 `Orchestrator (Argon)` 在同一轮中混合规划模型与 Gemini 4 Hydrogen，回合用量未按子模型拆分 token，保持未定价。这些数字是公开 API 标价，不代表 Google AI Pro / Ultra 订阅额度或 Gemini Enterprise 席位积分。

## Codex 会话额度

通过 ChatGPT 登录 Codex 时，回复在价格右侧显示“本轮周额度”。服务端按当前 Codex 会话 ID 归属周额度、5 小时额度和余额 credits，读数表示该会话在当前额度周期内的累计消耗，不受其他独立会话影响，不能把各轮页脚相加；悬浮说明会注明这一累计统计口径。已返回的有效零值显示为 0，极小正数保留精度，超过 100% 的有效读数也会保留。

## 可用性与诊断

缺少的额度窗口不显示；部分结果标为“统计中”，服务未返回有效结果时显示“服务未返回”，尚无读数时显示“暂无数据”。任务结束和打开历史时会刷新该会话最新的结果；缺失或不完整时，最多在 30 秒、2 分钟和 5 分钟后重试。这些会话统计读取不发送模型请求，不延迟发送或完成，每次最多等待 8 秒。部分会话即使已有本机 token 记录，服务仍可能不返回额度归属数据；不能据此认定没有消耗或保证稍后一定可用。旧接口返回的会话 credits 和金额可作为后备显示，但不会换算成额度百分比。API Key 会话不查询订阅用量。

## 本轮预估周额度

通过 ChatGPT 登录的 Codex 新回合和通过 Google 账号登录的 Antigravity 新回合会在回复下方显示“本轮预估周额度 …%”（Antigravity 按本轮模型自动匹配 Gemini 模型或 Claude 和 GPT 模型池）。范围是本条用户消息及其回复，计算方法为本轮结束后的周额度**已用百分比减去开始前的已用百分比**；例如从 30% 到 30.5%，显示“本轮预估周额度 0.5%”。模型请求发送前的额度读取 Codex 最多等待 3 秒、Antigravity 最多等待 8 秒（新启动 Antigravity 会话时与 CLI 连接并行），失败或超时仍继续发送，等待时停止任务则不再发送。正常结束，以及产生结果记录的停止或失败回合，都会异步读取结束额度（Codex 最多等待 3 秒，Antigravity 最多等待 8 秒），不延迟完成通知。两次读数的重置时间允许相差不超过 1 秒（若开始读数为 0% 且全新滚动窗口在本轮锚定重置时间，允许随本轮耗时向后推进），且都必须有效并晚于结束采样时间。缺少有效读数、无法确认同一周额度周期、期间发生重置或差值为负时，显示“本轮预估周额度 暂无数据”。有效差值为零时显示 0%，极小正值显示 <0.0001%，其他数值最多显示四位小数。悬浮说明展示开始值、结束值和公式。其他会话、其他客户端的使用和统计延迟可能影响这个账号估算；0% 只表示报告的读数未变化。

本轮估算及开始、结束快照会随对应回复保存。历史刷新、token 修复、会话统计重试和重启都不会重新采样。已有有效预估值（包括零值）会保留；历史记录缺少有效预估值且有完整起止快照时，页脚按同一规则重新计算，无需网络请求或存档迁移。若结束采样返回前已开始下一轮、会话被删除或重新导入、CLI 会话已切换，则丢弃迟到的数据。旧回复缺少开始快照，不补算。API Key 回合没有订阅额度预估。

## 历史用量恢复

Codex 历史导入和同步也会从日志恢复用量。旧结果能与日志中的轮次唯一对应时，打开对话或用量页会修正 token，保留原消息、耗时和额度记录，并同步修正分叉副本。日志缺失时，用量留空或保留旧记录，不把适配器的最后一次请求当成整轮。设置了 `CODEX_HOME` 时从该目录读取日志，否则使用 `~/.codex`。每条新结果会记录使用的 CLI，后续切换 CLI 仍按原来的来源计价。
