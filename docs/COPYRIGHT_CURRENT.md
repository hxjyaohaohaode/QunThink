# 群想技术材料草稿与源码边界


版本边界：430文件工程基线与随后435文件首次文档同步，是2026-10-09材料整理时的历史记录，不是当前HEAD文件数；当时“仅文档、业务未改”的结论不适用于后续运行逻辑修复。本轮生产文件身份与45项审阅顺序见[copyright-preparation/source-identity.json](copyright-preparation/source-identity.json)和[source-excerpt-order.json](copyright-preparation/source-excerpt-order.json)，原始字节、摘要和物理行已重算。清单排除自身，整库tree、同步提交及新CI须从外部最终回执或精确Git记录读取；历史CI和Render只证明各自所列提交。

本稿用于整理软件著作权准备资料，不是申请表、权属证明、正式鉴别材料或登记通过意见。仅反映已盘点的冻结源码、既有执行证据和未确认事项。

文档同步前工程基线核对完成：430文件源码已于2026-10-09 11:24:47 UTC合并主线；PR与合并后精确main CI均首次通过，Render实际命中跳过部署保护。本稿仍为软著准备草稿，不是已定稿申报材料。

## 软件识别

- 页面简称：群想；README英文标识：QunThink。
- 拟申请人为用户个人；法定姓名、权属依据、正式中文全称、登记版本、完成日期和首次发表日期：待事实核对。
- 后端组件ai-chat-group-backend及前端组件ai-chat-group-frontend均声明1.0.0；它们不能自行替代登记版本。旧“功能升级交付报告.md”的v2.0及“系统功能分析报告.md”的2.0.0属于旧文档标识。
- 文档同步前工程基线：430文件；main合并提交6646d89f03c0b29e39df3a466b2d81b4f2d8e28b；内容树6300935871b0650a759d79816d7a5cbc27279e36。PR #3于2026-10-09 11:24:47 UTC合并，其审查头为6a2cf2b919e877d1cef94bf4ebdee74d9cc017bf。该430文件基线已逐项复核SHA-256，这项430文件身份只对应当时的历史准备包；新版同名SHA256清单标识新版源码，不可反向替代旧基线。
- 430文件工程基线的来源：其中原427文件与历史main提交f6eb4567fd7a7cafa96fa882da1809cadbf24ada、内容树364d29dd9e358ff04f9d36d473527dd5346df3ee逐字节相同。该430文件基线相对于427文件业务基线仅新增THIRD_PARTY_NOTICES.md、frontend/public/THIRD_PARTY_NOTICES.html、frontend/public/third-party-licenses/react-bits.txt；未改业务代码、Logo或顶层LICENSE。

## 技术环境

Node.js最低22.12；后端为JavaScript、Express、WebSocket，前端为TypeScript、React、Vite和Zustand；HTML/CSS构成页面与样式。默认按账号隔离的LowDB/JSON存储，代码含MongoDB及PostgreSQL存储适配，但不得据此宣称每项特性在所有后端上均可用。个人目标采用需显式迁移的PostgreSQL领域表。默认本地前端3010、后端3002，生产必须使用session认证及正确持久化/加密/CORS/短信配置。

## 当前功能与实现对应

1. 模型连接、目录发现、能力声明与显式测试：frontend/src/components/Layout/ModelCenter.tsx；backend/src/routes/modelCatalog.js；backend/src/services/ai/catalog.js、modelProbes.js。保存不等于验证，测试可能收费。
2. 普通会话、用户与单AI私聊、2至5个AI间私聊、消息与流式反馈：frontend/src/components/Layout/NewChatModal.tsx；frontend/src/components/Chat/；backend/src/routes/groups.js、messages.js、ai.js；backend/src/websocket/index.js。普通会话允许零AI，数据仍属当前账号边界。
3. AI角色、智能体配置与会话、辩论：frontend/src/components/Layout/AIPersonaEditor.tsx、AgentCreateModal.tsx、AgentsPage.tsx、AgentChatView.tsx；backend/src/routes/agents.js、personas.js；backend/src/services/agent/index.js、debate/index.js。现有Agent会话新增“停止生成”：中止当前回复接收，已收到正文保留并标明未完成，不自动重发；实际已保存内容须刷新会话核对。JSON与multipart连接中断将取消信号传给主回复、意图分析及附件标注/描述；删除Agent后取消本进程同账号对应活动调用，消息写锁内再次确认Agent存在，防止迟到结果复活已删历史。首token前停止不保存空的成功助手消息，部分输出停止保留incomplete状态。不能保证供应商停止推理或计费；本地文件解析仍按既有资源预算运行，取消登记不是跨worker总线。这是既有聊天闭环的限定修复，不是通用Agent执行能力完成。
4. 自有文档上传、文本提取、视觉模型图片理解及语音合成：backend/src/routes/files.js、tts.js；backend/src/services/fileParser/index.js；frontend/src/components/Chat/TTSSynthesizeModal.tsx。ZIP类文档提取新增有界子进程、输入/展开/输出及并发预算，超限明确失败；范围和限制见[资源预算说明](document-parser-resource-budgets.md)，不宣称PDF、CSV、文本或媒体已隔离。音视频附件仅元数据，语音合成不是语音识别。
5. 会话材料起草、人工正文版本、AI候选稿、采用/验收/文本下载：frontend/src/components/Writing/ConversationWriting.tsx、TaskResultEditor.tsx；backend/src/services/taskSources.js、taskResults.js。材料来源、当前正文和被验收版本分开记录。
6. 工作台任务、显式定时生成、未知结果核验：frontend/src/components/Layout/WorkspacePage.tsx；backend/src/routes/tasks.js；backend/src/services/tasks.js。只产生文字草稿与材料整理，不操作外部办公软件。
7. 个人笔记、消息摘录、更正/遗忘及删除核验：frontend/src/components/Layout/MemoryCenter.tsx；backend/src/routes/memory.js；backend/src/services/memory/persistentMemory.js、deletionBarrier.js。旧性能/自动记忆接口返回501；MongoDB/PostgreSQL记忆账本尚不支持。
8. 可选个人目标、运行记录、零费用确定性目标简报：frontend/src/components/Layout/PersonalGoalsPanel.tsx；backend/src/routes/personalGoals.js；backend/src/foundations/；backend/db/migrations/。通用Agent执行不可用，简报不是目标验收证据。
9. 桌面/移动导航、主题、PWA、脱敏运行记录：frontend/src/App.tsx、stores/navigationStore.ts、utils/mobileNavigation.ts、components/Layout/RuntimeDiagnostics.tsx；frontend/vite.config.ts。不得宣称所有设备与离线场景均已通过。

## 当前不包含或不能作出的结论

没有真人共享群/组织成员完整权限；没有任意浏览器、文件系统或第三方软件自动操作；没有音视频内容理解或音频真实转写；没有通用外部搜索连接器；没有对模型解释的事实认证；没有完整费用结算；没有所有云存储/备份回滚情形的彻底删除保证；没有软件已上线、零漏洞、版权独有或登记通过结论。

## 验证记录与截图版本定位

2026-10-10测试验收修订：此前精确提交21cf5805aa17b17d2631bb1093439f5d76a21267的原生结果为55/58通过，整体失败；停止正文仍完整，但旧exact全文选择器把同一消息中的新增状态文字一起匹配，另有移动端旧登录场景遇真实HTTP429且未按服务端Retry-After恢复。此次仅修改测试：正文直接TEXT_NODE严格相等并覆盖缺字/多字负例；429只允许按服务端有效等待指示单次等待后真实重试，仍保留45秒界限及bob账号断言，不改生产鉴权和限流。最终本地前端577/577、类型检查与Vite构建通过，原生列表发现40项/7文件；列表不是实际浏览器通过，新精确提交CI仍待运行。生产208文件、64,370行和原45项审阅顺序完全不变。21cf作业接口实际返回7项（4成功、2 core失败、1未展开Docker跳过），不写成8项；其Render38018060098为job条件跳过，没有实际提交标记命中日志。

2026-10-10本次组合候选：现有Agent聊天取消与删除边界修复、前端生产依赖审计门禁收紧已写入源码；各生产文件及原45项审阅顺序的字节、摘要、物理行数重新计算，详见本页链接的source-identity和source-excerpt-order。独立核心候选本地前端560项、定向后端80项通过，并完成前端构建、品牌与OpenAPI核对；使用隔离账号与keyless loopback模型，不代表真实供应商或当前浏览器视觉验收。组合候选随后在Node22与真实PostgreSQL16完成后端417项、58/58测试文件且0跳过，前端初轮564项，补充原生停止场景与夹具回归后最终568项、类型检查和Vite构建、打包9项、品牌15文件及内联Logo、OpenAPI178操作无漂移检查通过；测试PG已停止并清理临时数据。新增桌面/移动停止场景2项，保留原38项，原生用例发现共40项；这里只执行列表发现，尚不是浏览器通过结果，夹具为keyless loopback模型而非真实付费服务。上述是组合代码候选本地结果，当前原生浏览器验收及含本次文档的精确托管CI仍待另核，不沿用旧提交身份。生产依赖审计门禁不再放行旧advisory例外；全依赖审计5项high仍未修复，依据和边界见[依赖审计说明](dependency-audit-2026-10-10.md)。本轮未部署生产。

截至2026-10-10（北京时间）的本轮材料更新：上一已核主线`99dcf7fb7a5a16f9a1c762cf881d18a4e58701ff`的[CI 37967228676](https://github.com/hxjyaohaohaode/QunThink/actions/runs/37967228676)首次8项作业通过，修复了目标运行领取竞态；其[Render 37968246342](https://github.com/hxjyaohaohaode/QunThink/actions/runs/37968246342)已观察同提交部署跳过。本轮新增ZIP文档资源限额属于之后的代码变更，不把这份旧主线结果转写为新候选CI通过；包含该变更的精确提交和实测范围须另行绑定。以下427/430记录继续作为历史。

本轮资源限额修复的文档更新前代码候选`952c5bff14968d02eaf3ca89e0172a7c32a18547`（443文件）已完成Node22与真实PostgreSQL后端407/407、57/57测试文件、0跳过；前端556、打包9项及品牌、OpenAPI、构建检查通过。这是该代码候选的本地验证，不代表本次文档合入后的精确提交已跑过托管CI。

历史427文件业务基线验收摘要：main提交f6eb4567fd7a7cafa96fa882da1809cadbf24ada，Actions运行37900387062，首次运行8项作业成功；后端389、前端556、浏览器56、打包9项通过，两个Docker镜像构建通过但未推送镜像。Render工作流37901291816实际命中提交消息跳过保护，不是生产部署成功。

运行链接：https://github.com/hxjyaohaohaode/QunThink/actions/runs/37900387062 。以上只记载历史业务基线的精确提交验收结果；应与下列430文件PR及主线验证状态分别记录。手册截图应从对应树的实际浏览器工件或重新采集记录筛选，逐图核对；不能把旧报告截图、mock回复或测试数量直接当作现版手册插图。仓内没有已完成的正式软著源码页或配图操作手册；本补充包另提供USER_MANUAL_DRAFT.md供定稿。

新增三文件的候选本地检查已包括前端556项、打包9项、类型检查、完整前端构建、品牌和OpenAPI检查；这不是新的后端/完整E2E/真实离线浏览器验收。PR提交6a2cf2b919e877d1cef94bf4ebdee74d9cc017bf的CI运行37922452782首次运行8项作业全部通过：前端556、后端389、浏览器56、打包9以及Docker构建2项通过，没有重跑。链接：https://github.com/hxjyaohaohaode/QunThink/actions/runs/37922452782 。main提交6646d89f03c0b29e39df3a466b2d81b4f2d8e28b的合并后运行37923561149同样首次8项作业通过：后端389、前端556、浏览器56、打包9以及Docker构建2项成功。主线CI：https://github.com/hxjyaohaohaode/QunThink/actions/runs/37923561149 。Render运行37924683298的job113800674449核对到同一提交，并于11:35:40.6364504 UTC实际输出跳过部署提示，在调用部署API前成功退出；这不是生产部署成功。Render记录：https://github.com/hxjyaohaohaode/QunThink/actions/runs/37924683298 。业务页面截图可保留原基线身份，并明确与未变业务文件的对应关系；新增许可页应另按实际页面核对，不能将旧图改称新树全量截图。

## 旧资料纠正用语

1. 功能联系.md:11及数据流中的“Pinia”：改为“前端状态管理采用Zustand；以frontend/src/stores中的当前实现为准”。
2. 分布式架构设计.md:11“本地SQLite数据库”：改为“当前默认采用LowDB JSON文件存储；代码另有MongoDB/PostgreSQL适配。本文后续微服务/K8s/消息队列为规划”。
3. 功能升级交付报告.md:16–19旧记忆加权算法：历史正文保留；前置标注“本报告为2026-08-23历史记录。当前digest列出持久可见记忆，不应将旧Map记忆加权算法、性能指标或自动保存视为现版能力；以backend/src/routes/memory.js和当前手册为准”。
4. 优化修复交付报告.md的“全部P0/P1、100%”属于当时特定基线结论：前置“历史报告，不代表当前430文件源码全功能、当前安全或上线结论；现版验证范围见当前材料索引”。不删除旧失败或旧成功。
5. 系统功能分析报告.md、设计方案.md、架构设计文档.md已带时效/规划声明，仍不得用于现版源码摘录。其历史文档版本、日期不能填入登记申请。

## 权属与第三方资料待补

LICENSE第3行署名为“Copyright (c) 2026 AI Chat Group”。这是仓库现有声明，不是已核对的真实权利人名称，也不能据此推定申请人身份。保持原许可不变，先确认原作者、历史授权及拟申报开发关系。

430文件工程基线包含新增根THIRD_PARTY_NOTICES.md、前端公开告知页frontend/public/THIRD_PARTY_NOTICES.html和逐字许可原文frontend/public/third-party-licenses/react-bits.txt，覆盖Lightfall、Radar、Strands三项视觉代码。该历史许可标题为MIT + Commons Clause License Condition v1.0，署名Copyright (c) 2026 David Haz，并非纯MIT。顶层LICENSE保持原样，不替代第三方条款，也不将这些代码重新许可为MIT。

该告知不代表所有第三方依赖已完成核查。锁文件仍含MIT/Apache等声明，sharp平台依赖另有LGPL相关声明，jszip有双许可；元数据不是完整许可原文或发行合规结论。应按实际发行内容继续盘点其他依赖、素材及取得依据。

Lightfall、Radar、Strands共7段shader已与React Bits官方较早历史版本逐字节对应，封装和接入层另有修改；不能再描述为来源完全未识别或全部自主原创。固定历史参考为Lightfall提交8f6b11306069db509a3055fabaa3ada233f14eee、Radar提交1a072c665d680a87ff9b304bc1d760ff73abef79、Strands提交d51a1e75dd5383d3fe8e2390c97ca3a480aa2aa3；各自源码及同版许可链接列在当前第三方告知页。

历史报告所列38_流星登录界面.md、39_雷达.md、14_超绝Siri感音频球.md原始文件和当时直接取得渠道仍未核实。官方内容同源证据不能补造当年的获取记录，也不证明整项目权属或全部商业使用条件已满足。这3个视觉文件继续排除在拟作为申请人自有业务源码的优先选取序列之外，保留上游版权和适用许可。

## 品牌与源码选取

scripts/brand-baseline.json记录基线ac69f6d6aa92b2b6f42166af26112bbdf3e9fd4c。本次独立SHA计算确认15个受保护完整文件及3组内联Logo摘要全部匹配。纯logo.txt摘要09e6eacb4e9cc715e9c948073620d0cef4af2b5d98eb5bf8b9cf3314bc7c4240；有字logo.txt摘要faec2e780810f5218f1b4406f119b758dbdff2269deaf483558164090d356b4b。字节一致不证明素材权利授权。

本轮按208项生产文件集合重算身份，另备45个业务候选文件、17,687物理行的审阅顺序建议，供权属确认后建立完整连续源程序目录；全量文件摘要见准备包QunThink-交付源码SHA256清单.txt。不是最终页码或60页鉴别材料；测试、夹具、依赖、锁文件及编译副本不用于凑页数。
