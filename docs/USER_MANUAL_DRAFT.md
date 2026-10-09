# 群想操作手册草稿


版本边界：430文件工程基线与随后435文件首次文档同步，是2026-10-09材料整理时的历史记录，不是当前HEAD文件数；当时“仅文档、业务未改”的结论不适用于后续运行逻辑修复。本轮生产文件身份与45项审阅顺序见[copyright-preparation/source-identity.json](copyright-preparation/source-identity.json)和[source-excerpt-order.json](copyright-preparation/source-excerpt-order.json)，原始字节、摘要和物理行已重算。清单排除自身，整库tree、同步提交及新CI须从外部最终回执或精确Git记录读取；历史CI和Render只证明各自所列提交。

初稿依据2026年10月9日文档同步前的430文件工程基线整理；该基线相对于历史427文件仅增加3个第三方来源与许可告知文件，原427文件逐字节不变，供逐步核对和定稿；尚未装配最终版本截图，不能直接当作正式提交版。产品简称为“群想”，英文标识为QunThink。拟申请人为用户个人；法定姓名、权属依据、正式软件全称、登记版本、开发完成日期和首次发表日期均待用户依据事实确认。前后端package.json中的1.0.0仅作为当前组件版本记录。

文档同步前工程基线核对完成：430文件源码已于2026-10-09 11:24:47 UTC合并主线；PR与合并后精确main CI均首次通过，Render实际命中跳过部署保护。本稿仍为软著准备草稿，不是已定稿申报材料。

文档同步前工程基线：main提交6646d89f03c0b29e39df3a466b2d81b4f2d8e28b；内容树6300935871b0650a759d79816d7a5cbc27279e36。PR #3于2026-10-09 11:24:47 UTC合并，原PR审查提交为6a2cf2b919e877d1cef94bf4ebdee74d9cc017bf。历史业务基线树364d29dd9e358ff04f9d36d473527dd5346df3ee及main提交f6eb4567fd7a7cafa96fa882da1809cadbf24ada保留作为原427文件和旧CI的身份，不将其写为430文件工程基线的main。430文件基线清单只对应当时的历史准备包；新版同名SHA256清单标识新版源码，不能反向证明旧基线。

## 1 适用范围与开始前准备

群想提供当前账号内的会话、多模型交流、角色配置、文稿任务与记忆记录。群聊保存在当前账号的数据边界内，不是多人共享群、团队成员权限或社交网络。可以不连接模型而先建立普通会话、保存材料和人工写作。需要AI回复、生成候选文稿或语音时，必须具备实际可用并通过相应能力测试的模型连接。

开发运行要求Node.js 22.12以上、npm及现代浏览器。前端为React、TypeScript、Vite，后端为Node.js、Express、WebSocket。默认开发前端端口3010，后端3002；部署者应以实际配置地址提供入口。生产环境需会话认证、稳定加密密钥、持久化数据目录、CORS及短信认证服务配置。不要把本地开发身份模式当作公网账户认证。

来源：README.md:1–35；frontend/package.json；backend/package.json；backend/src/index.js；backend/src/middleware/auth.js。

## 2 登录与界面导航

1. 打开部署者提供的群想地址，按登录页显示的认证方式进入自己的账号。
2. 在会话列表选择既有聊天，或打开“新建聊天”。桌面侧栏和移动端导航均可进入会话、智能体及工作台；实际入口位置应以本版真实截图补充。
3. 切换账号前保存当前内容。退出账号后，原账号的在途响应不能作为新账号结果；未保存草稿是否可恢复取决于具体页面和设备保存选项。
4. 设置中可调整外观、字号等；不要把界面导出的JSON理解为已验证的整机数据库恢复包。

来源：frontend/src/App.tsx；components/Layout/LoginPage.tsx、Sidebar.tsx、MobileTabBar.tsx、SettingsPage.tsx、DesktopSettingsModal.tsx；stores/navigationStore.ts；utils/mobileNavigation.ts（上述前端路径均相对frontend/src）。

## 3 连接并验证模型

1. 进入“工作台 → 模型中心”，点击“＋ 服务商”。填写服务商名称、API协议、服务地址和自己的密钥。协议可选“OpenAI兼容”或“Anthropic Messages”。更换地址或协议后，应重新填写该连接的密钥。
2. 点击“＋ 手动添加模型”，填写服务商给出的实际模型ID与显示名称；或先保存服务连接，再使用“拉取模型列表”。列表能返回模型ID不表示模型已通过能力测试。
3. 设置实际支持的对话、图片理解或语音等能力并保存配置。保存本身不发起付费能力测试。
4. 明确点击对应测试按钮。测试可能收费；图片理解测试需要2次调用。只有已验证能力才用于相应请求，修改参数或音色后需要重新测试。
5. 可设置默认对话、图片理解和语音模型。明确指定模型未就绪时，请检查配置，不应认为系统已悄悄换用其他模型。
6. 出现“结果待核验”时，保留请求号并点击“查询原请求状态”。不要把超时当作供应商没收到请求；必要时核对供应商用量。尚无自动费用核对或未知请求的通用安全重发能力。

本地模型地址必须被服务端精确允许。后端在云端时，localhost指云服务器，不是用户电脑。

来源：frontend/src/components/Layout/ModelCenter.tsx:60–168；backend/src/routes/modelCatalog.js；backend/src/services/ai/catalog.js、modelProbes.js。接口为/api/user/model-catalog及其test、tests/:requestId、discover子路径。

## 4 建立会话

### 4.1 普通群聊与无模型写作

1. 打开“新建聊天”，选择“创建群聊”。
2. 填写“群聊名称”，按需填写描述和头像。
3. “选择AI成员”为可选。没有已连接模型时可以不选AI，先保存会话和材料；不会自动得到AI回复。
4. 创建后在消息输入区记录材料或开始人工写作。以后连接模型，再依实际群设置配置可用成员。

界面显示成员计数，不应把显示的“/9”自行解释成经过验证的通用系统并发上限。本稿不据此宣称可同时运行9个模型。

### 4.2 用户与单个AI私聊

在“新建聊天 → AI私聊”选择一个已通过对话测试的模型，进入一对一会话。已有该模型的私聊可能被复用。

### 4.3 AI与AI私聊

在“新建聊天 → AI与AI私聊”选择2至5个AI，可填写聊天名称与话题，然后点击“创建AI私聊”。少于2个时不能创建，最多选择5个。这与上一节用户对单个AI私聊是两个不同入口。暂不连接模型时应使用普通“创建群聊”。

来源：frontend/src/components/Layout/NewChatModal.tsx:114–124、242–295、354–412、455–580；frontend/src/stores/groupsStore.ts；backend/src/routes/groups.js、ai.js。

## 5 消息 材料与会话查看

1. 在消息框输入内容，按界面发送按钮提交；可选择或提及当前会话可用的AI。模型流式内容与连接状态应以实际返回为准。
2. 通过附件入口上传自己的资料，核对附件名称与解析结果，再发送到相应会话。文本类文档可提取文字；图片理解依赖已验证的视觉模型。音频与视频附件当前只提供文件元数据，不具备真实音频转写或视频内容理解。
3. 通过搜索面板查找消息，通过群资料查看当前会话成员、相关文件和洞察。洞察是本账号已记录消息的统计，不是全平台用户统计。
4. 编辑、删除消息或清理群时先检查影响。任务和消息摘录可能因来源变化而要求复核；本地删除不自动撤回已交给供应商或已导出的内容。
5. 需要语音时，从相应消息的语音合成操作配置并提交；供应商请求可能收费。出现unknown或“需要核验”时先核对原请求，不能当作未调用成功而反复新建。
6. 辩论和观察者控制依赖会话实际可用的模型与配置。本稿不将其描述为独立专家认证或多个模型得出了可靠共识。

来源：frontend/src/components/Chat/MessageInput.tsx、MessageList.tsx、MessageActions.tsx、SearchPanel.tsx、GroupInfoPage.tsx、TTSSynthesizeModal.tsx、DebateControlPanel.tsx、ObserverControlPanel.tsx；backend/src/routes/files.js、messages.js、tts.js；backend/src/services/fileParser/index.js；backend/src/services/debate/index.js。

本轮ZIP类文档限制：DOCX、XLSX、PPTX、EPUB及ODT/ODS/ODP文本提取有压缩输入、实际展开量、文本输出、时间及并发上限，超限会明确失败，不把截断内容当作完整成功。请拆分超大文档后重试；ZIP列目录不展开正文。具体预算和未覆盖格式见[资源预算说明](document-parser-resource-budgets.md)；128MiB是V8旧堆限制，不是操作系统RSS硬上限，也不代表所有文件格式均已隔离。

## 6 将自己的材料整理成文稿

1. 在会话写作入口填写文稿名称、“用途与检查要求”。可从具体消息继续起草。
2. 核对实际读取的材料。该入口使用本会话最近最多40条消息；从某条消息开始时还保留起始消息来源标识。用途描述只是写作要求，不是完成的正文。
3. 点击“保存用途，开始写正文”，进入同一份文稿。无需连接模型也可人工写作。
4. 编辑正文并保存版本。需要AI帮助时，先连接并测试对话模型，再点击“让AI提供候选稿”。候选稿不等于用户已经验收。
5. 展开“版本与生成记录”阅读完整版本；选择历史版本时使用“检查后采用此版本”。采用不等于验收。
6. 核对正文、来源与版本后点击“验收版本…”。有未保存修改时先保存；来源已变化时先按提示复核，不能沿用旧验收掩盖新输入。
7. 可“复制全文”“选择全文”或“下载文本”。不要将文本下载描述成已实现Word/PDF版式导出。

来源：frontend/src/components/Writing/ConversationWriting.tsx；TaskResultEditor.tsx:120–138；backend/src/routes/tasks.js:53–71；backend/src/services/taskSources.js、taskResults.js。

## 7 使用工作台任务与定时生成

1. 打开“工作台”，创建任务，填写名称、用途/检查标准，选择“工作”“社交”或“娱乐”场景。
2. 选择运行模型及“作为依据的会话”，也可选“不读取会话”。保存后可以先人工编辑正文。
3. 如确需自动生成，展开“定时生成”，主动勾选“到时间自动生成”。填写界面标明时区下的未来时间；重复可选仅一次、每小时、每天或每周。自动生成依赖服务持续运行以及可用模型，并可能产生费用。
4. 在“想法与成果”查看任务，可按场景、已确认文稿或搜索条件筛选。
5. “正在生成”“等你检查”“已确认成果”“来源已变化”“需要核验”各有不同含义。生成完成之后仍应检查正文和验收版本。
6. 需要暂停时使用“暂停定时”；已发送的远端请求不保证被撤销。结果未知时先核对供应商调用记录，再决定“已核验，允许重试”或“停止后续生成”。
7. 保存请求未确认时使用当前页面提供的同一请求核验/恢复入口，不要为同一意图反复建立新任务。

任务当前产生模型文字草稿与会话材料整理，不会自动操控浏览器、文件系统或第三方办公软件；“工作”“研究类提示”不表示已接入独立联网研究服务。

来源：frontend/src/components/Layout/WorkspacePage.tsx:23–25、144–149、211–254；Writing/PendingCreateRecovery.tsx、PendingResultRecovery.tsx；backend/src/routes/tasks.js；backend/src/services/tasks.js。

## 8 创建并使用智能体

1. 进入“智能体”并新建，填写名称、用途说明、开场语和运行模型。
2. 在下一步回答实际生成的配置问题；没有问题时按页面继续。配置问题/提示词的生成来源应以完成结果的真实说明为准。
3. 完成后打开该智能体会话，按需要提交文字或文件。
4. 定时执行应另到工作台建立任务。该智能体当前不具备任意外部搜索、浏览器控制或工具执行权。
5. 删除智能体前阅读确认信息；不要用该操作代替对供应商留存信息的删除。

来源：frontend/src/components/Layout/AgentCreateModal.tsx:243–289、319–365、435–443；AgentsPage.tsx、AgentChatView.tsx；backend/src/routes/agents.js；backend/src/services/agent/index.js。

## 9 记忆记录与遗忘核验

1. 打开“工作台 → 记忆记录”。在“写一条个人笔记”输入内容并保存，单条上限5000字。
2. 阅读记录中的类型、时间、修订号和来源。个人笔记标为用户自述未核验；消息摘录也未经事实核验。个人笔记目前不会自动进入群聊上下文。
3. 对个人笔记点击“更正”，核对基于的修订再保存；有并发变化时先阅读当前版本，选择“基于当前版本继续编辑”。
4. 选择“遗忘”并核对确认。结果未知时正文继续隐藏，可点击“重试核对遗忘”，或“稍后核对，继续使用”。记录不存在或空列表不代表遗忘已被确认。
5. 设备上可保留不含正文的账号归属、记录编号、时间和核验状态。清理浏览器站点数据会失去设备核验信息，不撤销服务端已经完成的遗忘。
6. 当前独立删除账本只支持本地单进程LowDB。MongoDB/PostgreSQL模式的记忆接口会拒绝服务；整个数据卷连账本一起回滚仍不安全。不要写成所有存储后端、备份与派生产物已彻底删除。

来源：frontend/src/components/Layout/MemoryCenter.tsx；frontend/src/stores/memoryStore.ts；backend/src/routes/memory.js:21–55、127–148；backend/src/services/memory/persistentMemory.js、deletionBarrier.js、installation.js；README.md记忆说明。

## 10 个人目标 可选管理员配置功能

只有管理员已配置并迁移PostgreSQL领域基础表后，才使用“工作台 → 个人目标”。服务不可用时会显示503说明，不能冒称目标已执行。

1. 点击“＋ 创建目标”，填写希望得到的可检查结果、硬约束和至少一条验收条件。
2. 保存后查看目标、步骤和状态。当前预算固定为零，不授予工具或付费权限。
3. “记录执行步骤”只保存待领取运行；通用Agent没有自动执行者。
4. 如选择“生成目标执行简报”，仅明确授权内部Worker在24小时内整理该目标当前修订的结果、约束与验收条件，不调用模型、不产生费用。
5. 打开已保存简报核对内容。简报不是目标完成证据，不能用它代替实际成果及验收。

来源：frontend/src/components/Layout/PersonalGoalsPanel.tsx:263–299；backend/src/routes/personalGoals.js；backend/src/foundations/internalGoalWorker.js；backend/db/migrations/001_foundations.sql、002_agent_runtime.sql。

## 11 草稿恢复 故障与安全使用

文稿编辑器提供“加密恢复未提交草稿”和“保留私人已保存文稿的加密离线副本”两个独立选项。前者仅此浏览器使用，退出时清除；未开启时，页面切换仍可继续，但刷新或关闭会失去未提交修改。离线副本不证明当前权限，重新联网核对后才能使用。记忆笔记草稿、模型配置草稿有各自更严格的当前标签页保存边界，不能把文稿恢复能力推广到全部页面。

遇到来源变化、保存冲突、账号切换、unknown结果、无模型或服务暂不可用，应按当前具体错误处理；不得将空白、旧缓存或超时显示当成成功。可在“运行记录”查看脱敏诊断，但诊断不等于真实供应商费用凭证。

来源：frontend/src/components/Writing/TaskResultEditor.tsx:135–138；components/Layout/RuntimeDiagnostics.tsx；docs/task-result-lifecycle.md、model-probe-recovery.md、memory-forget-device-recovery.md、indexeddb-account-boundaries.md。

## 12 定稿前需补的真实截图

建议按本稿操作顺序采集：登录入口、模型中心保存与测试状态、新建聊天三种入口、零AI普通群、AI与AI私聊2至5成员、消息与附件、会话起草及来源、正文版本与人工验收、定时任务设置、记忆更正和遗忘待核验、个人目标未配置或真实已配置状态、移动导航及运行记录。

每张图记录源码树、页面/步骤、采集时间、实际运行环境和输入来源，使用专门的非个人测试内容；演示输入明确标识，不虚称客户案例。没有模型实测时可拍“未连接/待测试”状态，不能用模拟回复冒充付费供应商验证。历史业务基线CI运行37900387062证明当时限定自动化场景通过，不能代替不同提交的后续CI或上述图片的筛选与嵌入。PR运行37922452782已全部通过；main提交6646d89f03c0b29e39df3a466b2d81b4f2d8e28b的合并后运行37923561149首次8项作业通过，Render运行37924683298已核实在部署API调用前实际跳过；原业务文件未改的事实不应抹去截图实际采集版本。

## 13 第三方来源与许可告知

部署后可访问/THIRD_PARTY_NOTICES.html查看Lightfall、Radar、Strands视觉代码的历史来源、版权和完整许可文本；源码中对应THIRD_PARTY_NOTICES.md、frontend/public/THIRD_PARTY_NOTICES.html及frontend/public/third-party-licenses/react-bits.txt。三项代码的7段shader已与React Bits官方历史源码逐字节对应，适用历史许可为MIT + Commons Clause，不能称为纯MIT或全部自主原创。原始中文参考文档及当时直接取得渠道仍待核实。告知页不证明其他依赖或整个项目的权属已核清；顶层LICENSE未改。

本节只是新增告知入口说明，以上业务操作流程没有改变。
