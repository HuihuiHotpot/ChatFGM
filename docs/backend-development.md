# ChatFGM 后端开发说明

## 1 当前范围

ChatFGM 是 Windows 桌面工作台。当前已接入：

1. Electron 桌面宿主、单实例/单主窗口、窗口状态恢复和启动错误反馈。
2. 项目登记、目录树、文本文件操作、六类文件查看器（文本/Markdown、CSV、图片、HTML、HDF5）和项目工作区持久化。
3. 依赖设置：Codex CLI 检测/连接、ChatGPT 账号状态、DeepSeek API 服务、Flamelet 工具箱与 Python 环境。
4. Agent 对话：项目内多段对话、原 thread 续聊、流式消息、历史分页、附件、项目引用、临时截图、停止、设置互斥、退出等待、未知提交核实和重启恢复。
5. 第 7 步：三档权限、服务器请求审批闭环、工具箱文件夹发现与绑定、原位 AGENTS/skills/tools 加载、Python 环境内执行、外部文件同步与保存冲突处理、审批与执行信息持久化。

第 7 步已完成产品范围内的后端功能，并完成 2026-11-01 验收缺陷修复（R1～R8 已修复；R2 通过按对话归属的执行连接冷恢复同一 thread，不再要求新建对话）。随后完成第 8 步本地验收与授权隔离账号的在线联调；本文件第 12～16 节保留第 7 步历史记录，不能作为当前验收结论。最新结论以独立验收报告及其源码哈希为准。工具箱发现、资源加载和 Python 环境约定见 `docs/toolboxes.md`。

## 2 技术栈与命令

- Electron 45.1.0、React 19、TypeScript 5.9、Vite 7、Playwright 1.64.1。
- SQLite 使用 Electron 内置 `node:sqlite`，不引入第三方数据库依赖。
- Codex CLI 使用真实 app-server JSONL 协议。第 7 步验证版本为 `0.165.0-alpha.1.2`（协议导出见 `test/protocol/app-server-schema-0.165.0-alpha.1.2/`）；2026-11-01 在线联调及随后的完整回归使用 `0.163.0`。版本是测试环境事实，不是安装目录或生产代码中的固定约束。

```powershell
npm run typecheck
npm run lint
npm run build:desktop
npm run test:storage
npm run test:desktop -- --retries=0
npm run test:ui -- --workers=4 --retries=0
node test/backend/run-chat-probe.mjs
node test/backend/run-real-codex-probe.mjs
node test/backend/run-step6-fixes-probes.mjs
node test/backend/run-step7-real-codex.mjs
```

## 3 进程与数据目录

- main、preload、renderer 严格分离；renderer 不启用 Node，所有文件和数据库访问经正式 preload/IPC。
- 每个 IPC 校验发送方、主框架、参数和项目边界；不暴露通用 `invoke`。
- 开发模式使用 `%APPDATA%\ChatFGM-dev`，production 使用 `%APPDATA%\ChatFGM`，自动化使用隔离的 `testRoot`。
- 测试不读取真实用户 Codex 认证、不写入真实 ChatFGM 数据库；测试结果统一位于 `test/results/`。
- Codex 认证仍由 Codex 管理；ChatGPT 使用 `codex/auth`，API 服务使用稳定的 `codex/services/<serviceId>`。设置保存、模型准备和聊天服务 home 分离，不因 `prepareModel/resetModelHome` 删除聊天历史。
- app-server 进程启动时附加 CLI 配置 `features.experimental_windows_sandbox=true`。真实 CLI 0.165 默认关闭 Windows 沙箱后端，未开启时写权限命令会被策略拒绝；该标志是 CLI 已支持的配置覆盖，不是协议扩展。

## 4 SQLite v8

`backend/storage/migrations.ts` 在 v1～v7 后追加 v8，已有历史迁移不改写。

v8 新增：

- `chat_approvals`：不透明审批 id、项目/对话/run/turn/thread/item 身份、方法、种类、内部 `request_key`、仅用于展示的 payload、状态（pending/approved/denied/expired/cancelled）、运行实例和连接代次、创建/决定时间。
- `chat_runs` 追加列：`toolbox_name`、`execution_cwd`、`environment_path`、`interpreter_path`、`interpreter_version`、`sandbox`，记录该 run 实际使用的执行事实。

迁移保持原子性；重复启动幂等；失败回滚；v1/v2/v6 升级测试验证既有项目、身份、窗口、设置、工作区、恢复记录和对话不丢失。

## 5 对话标识、权限与协议

标识链：

```text
projectId -> conversationId -> serviceId + threadId -> submissionId + turnId -> runId
```

- 每个对话首次发送时创建 thread，后续原 thread 续聊；不静默替换历史。
- 服务级连接负责认证和模型发现；执行连接按对话归属，多个对话分别持有执行进程和 thread，共享服务的稳定历史 home。
- 三档权限均由真实运行层执行，默认只读：

| 权限 | thread sandbox | approvalPolicy | turn sandboxPolicy |
| --- | --- | --- | --- |
| 只读 `read-only` | `read-only` | `never` | `readOnly`，无网络 |
| 项目内读写 `workspace-write` | `workspace-write` | `on-request` | `workspaceWrite`，`writableRoots=[项目根]`，无网络 |
| 完全访问 `danger-full-access` | `danger-full-access` | `never` | `dangerFullAccess`，仅来自用户明确选择 |

- 每轮发送使用提交时冻结的权限；`thread/start`、`thread/resume`、`turn/start` 使用同一权限快照。运行中修改控件只影响下一轮。
- 运行中对话的历史读取返回本地快照；运行结束后通过只读 `thread/turns/list` 与 `thread/items/list` 分页读取。`thread/resume` 用于执行连接恢复，不用于历史查询。
- Windows 沙箱可用性：CLI 检测/连接后读取 `windowsSandbox/readiness`；`notConfigured` 时调用 CLI 自有 `windowsSandbox/setupStart` 一次并等待 `windowsSandbox/setupCompleted`，随后复查。`updateRequired` 或初始化失败明确报告；写权限请求不会回退为完全访问。只读仍可用。
- 协议导出使用 `codex app-server generate-json-schema --experimental`，资料位于 `test/protocol/`，不直接套用新版文档字段。

## 6 审批闭环

`CodexAppServerProcess` 现在接收服务端请求：

- 支持 `item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval`。
- `item/tool/requestUserInput` 返回合法的空答案，避免 Plan 模式问题造成等待死锁；MCP elicitation、动态工具、token 刷新、attestation、外部时钟等当前流程不会产生或无法安全支持的请求明确返回 JSON-RPC 错误，不静默悬挂、不自动放行。
- 每个请求记录连接代次、thread、turn、item 和 JSON-RPC 请求身份；`respond`/`reject` 还校验创建该回调时的原始 pending-state 对象，因此同 ID 后继请求不会被旧回调结算。`serverRequest/resolved` 会核对 thread 后立即从该连接 pending 表移除原请求、将持久化审批标记 expired 并推送界面，迟到点击不再发 RPC；其他请求和 run 终态不受影响。
- ChatService 为每个审批生成不透明 id 并持久化；renderer 只收到展示事实（命令/路径/工作目录/原因）和不透明 id，只发送 id + `approve|deny`，不能提交修改后的命令或路径。
- 批准命令/文件变更使用 `accept`，拒绝优先 `decline`（服务端提供时），否则 `cancel`；权限批准回显请求的权限 profile，拒绝返回空权限。拒绝后不伪造整轮 stopped/failed，以运行层后续事件为准。
- 权限审批展示 `readPaths`、`writePaths`、`denyPaths`、网络开关、`networkApprovalContext` 目标（host/protocol）和授权范围（本轮/本次命令）；命令的 `additionalPermissions` 同样展示。批准 payload 与展示 profile 一致，不增加未展示范围；协议新增的 glob/special 路径以可读标签展示，无法完整映射的结构直接拒绝而不是静默放行。
- 多个请求分别保留身份；弹窗关闭/Esc 只表示暂不处理；后台请求不切换对话、不抢焦点。
- 等待审批计入活跃运行；停止运行会以 `cancelled` 结束该 run 的等待审批；`turn/completed`、失败、停止、断线和进程退出会收敛未决审批。重启后旧 pending 审批统一标记 expired，不能再次批准。
- 审批记录可用于历史查看；快照包含已决定记录，内部 `request_key` 不暴露给 renderer。

## 7 工具箱发现、绑定与原位加载

- `backend/toolboxes/registry.ts` 只扫描 `toolboxes/` 下一级文件夹；文件夹名即 `ToolboxDefinition.name`，同时作为 id 和显示名称。不再读取 `toolbox.json`，不再维护 id/label 映射，不再限制 ASCII 标识符。
- 每个工具箱独立报告问题：缺少 `standardCase` 时该工具箱不可用于创建/执行，但其他工具箱继续可用；skills 目录、缺失 SKILL.md、重复技能名、链接/损坏资源给出具体原因。
- `backend/toolboxes/name.ts` 统一校验文件夹名：中文、空格、数字开头均可；拒绝路径分隔符、`.`/`..`、Windows 非法字符、控制字符、设备名和尾随点/空格。设置保存/加载、项目创建/绑定、环境选择/detect 和 IPC 共用该校验，不再使用 ASCII `TOOLBOX_ID`；大小写不同的重复环境配置按 Windows 文件夹语义拒绝。既有 ASCII 配置继续可读。
- 未绑定项目仍可打开、浏览和进行普通对话；对话区显示“尚未绑定工具箱”和“选择工具箱”。绑定只保存工具箱类型，不初始化 `standardCase`、不覆盖已有文件；已绑定项目不支持本阶段随意换型。
- 创建、打开或绑定项目时，`ToolboxCatalog` 按文件夹名读取一次对应工具箱并放入本次应用运行的进程内缓存（目录、`AGENTS.md` 正文、技能名称/描述/真实 `SKILL.md` 路径、`tools` 目录）；同一工具箱由多个项目/对话复用，后续普通消息不重扫目录也不重读 `AGENTS.md`。加载失败明确报告且不缓存失败结果，不会自动改绑其他工具箱。资源修改在用户重启应用后生效，不做文件监控/自动刷新。
- 绑定工具箱后，普通消息从缓存生成有界 developer instructions；显式 `/技能名` 调用仍在该次请求中附加应用读取的当前原位 `SKILL.md` 正文（128 KiB 上限）和原始技能目录，不复制、不安装，也不会把其他技能全文注入普通消息。项目自身 AGENTS.md 仍由 Codex 从项目 cwd 加载，不被覆盖。显式技能被删除、不可读、超限或名称无效时返回明确错误，submission 保持未发送，不创建 turn。
- 不复制工具箱资源到项目、应用缓存或 `CODEX_HOME`；不安装项目技能目录，不建立快照。
- 工具箱被删除/改名时明确报告缺失，不自动绑定其他类型。

## 8 Python 环境内执行

- 每个工具箱在依赖设置中配置一个 venv/Conda 环境根目录；后端解析真实解释器绝对路径，不退回系统 Python。
- 环境检测只验证解释器可运行、属于所选环境并返回版本；`probeScript`、minimum/maximumVersion、requiredModules 检测依赖已移除。专业依赖由技能说明要求 Agent 按需检查，缺失时明确说明，不自动安装。
- 发送路径复用已保存环境的解释器解析与设置检测结果，不再同步启动 Python 读取版本；显式修改环境配置后本进程的环境解析/检测缓存失效，下一次发送按新配置准备执行上下文。
- 新 thread 通过 `config.shell_environment_policy.set` 建立环境：PATH 前置环境目录，设置 `CHATFGM_PYTHON`、`CHATFGM_TOOLBOX`、`CHATFGM_TOOLBOX_DIR`、`CHATFGM_PROJECT_ROOT`、`CONDA_PREFIX`/`VIRTUAL_ENV`、Python UTF-8/无用户 site 等标识。只影响该 thread，不修改共享 app-server 进程的全局 PATH。
- **已加载 thread 的热更新限制与冷恢复（本机 Codex 0.165.0-alpha.1.2 实测）**：已加载 thread 内，`thread/resume` 的 `config`/`developerInstructions` 被忽略；`thread/settings/update` 不接受 shell 环境字段（尝试 `config`、`shellEnvironmentPolicy`、`shell_environment_policy`、`environment`、`env` 均未生效）；`config/batchWrite` + `reloadUserConfig` 也不改变该进程的 shell 环境。**但用全新 app-server 进程恢复同一 thread、在 resume 时提供新的 `shell_environment_policy.set` 是有效的**：thread ID 与历史保留，真实命令使用新解释器和环境；基础配置可以仍为 A，B 由 resume 显式提供。产品据此不修改共享配置、不新建对话，而是由目标对话结束旧执行 owner 后在稳定历史 home 上冷恢复原 thread。详见第 7 节和运行层说明。
- 服务级认证、账号身份、模型发现和能力上下文仍由服务连接共享；实际执行连接按 conversation/thread 归属，按需启动。服务连接不承载对话 turn，也不因单个对话环境切换而关闭。
- `backend/chat/runtime.ts` 维护 conversation → 执行连接、初始化 promise、取消 token、连接 generation 和进程 PID。`ChatService` 用每对话执行锁串行化“准备/迁移/首次 resume/启动 turn”，其他对话和整个服务不被锁住；同一 thread 任一时刻只有一个可提交新 turn 的 owner。
- 发送前计算执行环境指纹，至少包含项目 cwd、工具箱名/原位目录、环境根目录、真实解释器、实际 shell 环境变量集合。已有 owner 的已应用指纹和 thread id 都匹配时直接复用；历史查询产生的 owner（指纹未知）、工具箱/环境变化、旧 owner 已退出时，只结束该对话自己的执行进程并等待退出，再用同一稳定历史 home 冷恢复原 thread。历史 run 的 environmentPath 不作为当前进程环境已应用的证明。
- 冷恢复必须收到相同 thread id 的 resume 回执；失败返回 not-sent 并保留历史/草稿，不回退 `thread/start` 创建新历史。成功后才把新 owner、指纹、thread id 标记为已应用；旧连接退订并退出，其迟到事件、审批和退出回调不能影响后继 owner。
- 模型、推理强度、权限/沙箱和本轮工具箱说明在恢复/启动时传入；已有 owner 的说明更新使用 `thread/settings/update`，缓存 key 包含连接 generation，避免新进程被旧进程签名跳过。
- ChatGPT 模式的登录、账号校验和认证生命周期仍由服务认证进程负责；对话执行进程使用同一稳定 auth home，只读取 CLI 原认证，不复制/解密 token，也不结束认证进程。API 模式复用服务配置、模型发现和密钥注入，服务地址限制不变，测试 provider endpoint 仅由测试选项注入。
- 历史读取对运行中对话直接返回本地快照，不访问远端 writer；运行结束后使用只读 `thread/turns/list` + `thread/items/list`，不使用 `thread/resume`/`thread/read` 重新装载或中断活跃 turn。已有 owner 的历史查询不改变权限、模型、cwd 或环境；未确定执行环境的历史 owner 下一次发送必须冷恢复。
- 停止、审批答复、resolved/过期、finalizeExecutionSessions、unknown 核实、孤立事件重放和退出清理均按实际 conversation owner/generation 路由；旧审批、旧进程退出和旧事件不能结算后继连接。服务配置、CLI、账号或模式变化时，相关服务上下文及其执行 owner 一起失效；无关设置保存不重启已有 owner。
- 发送准备保护：解析并固定工具箱环境后、进入 `buildSubmissionContent`/执行 owner 准备等异步步骤前，登记该工具箱的准备引用；设置保存必须在准备或运行期间拒绝同一工具箱的环境变更，其他工具箱仍可保存。准备失败、not-sent、取消和完成路径按具体引用释放，多个重叠准备使用引用计数，不会因一个结束而提前解除保护；运行交接后由活跃 run 保护继续生效。
- 退出确认：`CodexAppServerProcess` 在 `spawn` 返回后、等待 initialize 前保存 `stablePid`，因此底层 `start()` 内部因初始化失败调用 `dispose()` 清空 `child` 后，运行层仍能取得稳定 PID。`disposeConnection` 在显式 dispose、错误 owner 重建、服务重置、启动失败清理和正常替换前登记该稳定 PID；显式/错误重建路径有界等待并超时抛错，服务重置保留同步接口但登记 pending，启动清理同样保留。`pendingConversationExits` 按对话保存 PID，该对话的发送、历史加载和直接 ensure 都会被阻止，不能创建后继 owner 或提交新 turn。旧进程真正退出后清除对应 PID（只清理匹配身份，不误删后继），允许重试恢复原 thread；真正未产生 PID 的启动失败不制造 pending；正常退出不增加固定等待，其他对话不受影响。
- 同一服务多个执行进程共享稳定 home：服务层只负责配置/模型目录写入和认证协调，执行进程不在初始化时重写共享配置或重复模型发现；每对话独立进程由 CLI 自身的 per-thread writer/数据库锁协调。关闭应用会 dispose 所有自建执行进程。
- 已有 thread 的 developer instructions 更新使用实验 API `thread/settings/update` 的 `collaborationMode.settings.developer_instructions`；真实上游请求验证新说明生效，thread id 与历史不变。
- 真实 Codex 探针验证：命令实际看到该 PATH/环境变量，`& $env:CHATFGM_PYTHON .../debug_hello.py` 返回 `CHATFGM_DEBUG_TOOL_OK` 和原样中文/特殊字符文字，且报告的解释器路径与配置环境一致。
- 正式工具执行不套用环境检测的 12 秒超时；由 Codex 执行会话跟踪长命令。
- 历史记录：第 7 步验证时两个工具箱都提供 `debug-hello` 技能与工具并保持原位。调试示例不是 FGM 求解结果。
- 当前仅 `freelyPropagatingPremixedFlame` 保留 `debug-hello` 调试技能。`counterflowDiffusionFlame` 提供 `case-dict`、`mechanism`、`flamelet-computation`、`tabulation`、`validation` 和 `report` 六个技能。火焰面后处理已并入 `flamelet-computation`，流程覆盖制表、先验验证和报告。详见 [工具箱约定](toolboxes.md#当前内置工具箱与调试技能)。

## 9 执行输出、停止与文件同步

- 命令执行继续通过 Codex 的沙箱与执行会话，不建立绕过沙箱的后台代执行通道。
- `item/commandExecution/outputDelta` 合并到现有 run trace；内存缓冲最多 16 KiB、持久化工具详情最多 4,000 字符，截断有明确说明。普通 stdout 不要求 JSON，结果可由退出码、文本和产物表达。
- 停止只对所属 run/conversation owner 调用 `turn/interrupt`，不杀服务认证进程或其他对话 owner；turn 终态后通过 `thread/backgroundTerminals/list` 查找该 run 的 command item，使用 `thread/backgroundTerminals/terminate` 定向终止对应执行会话，并轮询 CLI 确认进程消失后才发布 stopped。终止失败/无法确认时 run 保持 `unknown`（待核实）并显示具体原因，不假报 stopped，也不允许关闭/退出提前完成；重试停止会在执行链确认结束后收敛为 stopped。
- 停止后的最终文件同步在该执行链清理后执行；`finalize` 失败会拒绝调用方并在 run 上追加可见警告。
- Agent 可能通过命令或文件工具改盘：`item/commandExecution/outputDelta`（节流）、命令/文件变更 `item/completed` 和 turn 终态触发项目重扫。
- `backend/workspace/file-sync.ts` 按项目串行、700ms 合并；最多一次在途扫描和一次排队扫描，突发输出不会堆积请求；完成、失败、停止都执行最终核对。每个 finalize 等待者绑定 request sequence，只有在请求之后开始的扫描成功后才 resolve；在途扫描不会满足后一次 finalize，必须完成补扫；补扫失败会 reject 依赖它的等待者，dispose 会结算所有等待者。失败通过 `projectSyncFailure` 事件暴露；关闭项目/退出在既有确认流程中等待 `flushProjectSync`，失败显示原因并允许重试，不依赖 `will-quit` 补异步工作。
- 重扫通过正式 `projectUpdates` 事件发送完整树、变更和删除的文件身份；前端原地更新项目会话，不重新打开项目、不改变最近打开时间或活动标签。
- 干净的文本/Markdown/CSV 重新读取并按版本更新，保留编辑/查看状态；干净的图片/H5 通过 `externalRevision` 重新读取，尽量保留缩放/选择；HTML 保留页面实例并提示“文件已更新”，由原刷新按钮加载。
- 未保存文本不自动覆盖，保留内容、撤销状态和恢复稿；保存冲突提供取消、重新载入磁盘、明确确认覆盖；覆盖前再次校验磁盘版本，确认期间再次变化会重新冲突。删除后保留脏文档并提供另存为。
- 外部重命名无法确认身份时按删除/新增处理，不凭文件名或相似内容猜测。

## 10 生命周期、互斥与恢复

- 保存工具箱绑定与实际执行信息（toolbox、cwd、环境、解释器/版本、sandbox）到 run。
- 活跃 run 阻止更换 CLI、切换当前服务/模式、修改相关服务密钥；扩展为：修改正在使用的工具箱环境被阻止，不相关工具箱环境仍可配置。
- 非破坏性设置保存不重启运行层；服务/CLI 变化只失效对应连接。
- 旧实例 `unknown` 继续通过原 thread 只读核实，不自动重发写操作；普通断线 unknown 不阻塞无关设置或正常退出。执行链终止无法确认的 `unknown` 属于当前待处理运行，会保留在任务列表并阻止关闭/退出，直到重试确认执行链结束。
- 应用重启时旧运行标记 unknown、旧 pending 审批标记 expired；只有当前实例、连接代次、thread/turn 实际匹配的运行才恢复 running。
- 退出/关闭项目前等待或停止运行，完成对话/工作区/最终文件同步保存；失败在既有确认流程中显示并可重试。
- 清理订阅、审批等待、预览、执行会话和自有进程；不删除项目文件、工具箱原文件、历史和产物。
- 第 6 步 R1～R6（发送队列、连接归属、写库失败保护、历史读取、并发连接、截图）保持不变。

## 11 IPC 与正式接线

新增并校验的通道：

- `respondChatApproval`：仅接受 project/conversation/opaque approvalId/decision。
- `bindProjectToolbox`：仅接受 projectId 与已发现工具箱文件夹名。
- `saveFileAs`：项目根内另存恢复内容，不覆盖已有文件。
- `projectUpdates`：主进程推送的文件同步事件。
- `flushProjectSync`：关闭/退出前等待所属项目最终扫描；失败返回具体错误。
- `projectSyncFailure`：普通后台扫描失败的可见通知，前端用现有提示条“重试同步”。
- preload 只暴露上述具体方法，不暴露通用 JSON-RPC 或 shell。

`saveFile` 增加 `force` 与冲突详情（`code`/`currentVersion`）；只有明确确认后才覆盖指定磁盘版本。设置扫描/新建项目的 ToolboxOption 携带具体 `error`，损坏工具箱独立显示。

## 12 第 7 步验证结果与证据

最终证据（本步）：

- `test/results/backend-step7-real-codex-2026-11-01T12-33-40-278Z-54624/`：真实 Codex 0.165.0-alpha.1.2 + 本地 Responses 夹具 + 真实 Windows 沙箱 + 两个真实 Python venv（27/27 直接 CLI 检查通过）。
- `test/results/backend-step7-real-codex-2026-11-01T12-33-40-278Z-54624/r2-service/summary.json`：正式 ChatService + 真实设置保存链的 R2 探针，88/88 通过；thread `01a1971b-dbde-7062-b851-47b4f2a76be7` 完成 A→B→A、重启、并发 long run 和其他连接审批隔离，真实 venv/解释器/环境变量输出与历史保留。
- `test/results/backend-step1/storage/2026-11-01T12-48-20-042Z-39356/`：77/77 存储与后端服务测试；包含 F1 准备门闩（首次、已有 thread、失败释放、重叠引用）和 F2 显式 dispose、错误 owner 重建、服务重置，以及**真实 initialize 回执错误 → 底层 dispose 清空 PID → 旧 OS 子进程仍存活**的启动失败路径；后者验证稳定 `stablePid`、阻止后继/并发重试、其他对话可用，旧进程真实退出后恢复。
- `test/results/r2-service-gate-1793536416155-48888/result.json`：F3 共享汇总门控的 32 个正反夹具（旧成功报告、当前非零退出、启动失败、超时、缺失/损坏/归属不符、checks 缺失/null/对象/空数组/无效元素/无效名称或状态、字符串/负数/小数计数、passed/failed/notRun 与明细不符、截断明细、notRun/内部失败、正常通过）。
- `test/results/step6-final-probes-r2.json`：前六步 R1～R6 回归。
- `test/results/backend-step7-real-codex-2026-11-01T03-41-51-676Z-36944/`：上一轮错误环境探针运行；其拼接历史/旧输出结论已作废，仅作历史诊断，本轮最终以 `12-33-40` + R2 service 路径为准。
- `test/results/screenshots/step7-approval-800.png`、`step7-approval-1000.png`、`step7-approval-1440.png`：权限审批（读/写/网络/范围）在三个宽度下的截图。
- `test/results/artifacts/`、`test/results/report/`：Playwright 桌面/前端运行产物与报告。
- `test/protocol/app-server-schema-0.165.0-alpha.1.2/`：实际安装版本协议 schema。

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run lint` | 通过 |
| `npm run build:desktop` | 通过 |
| `npm run test:storage` | 77/77 通过 |
| `npm run test:ui -- --workers=4 --retries=0` | 267/267（上一轮历史基线，本轮 app/共享 UI 未修改，未重跑） |
| `npm run test:ui -- test/frontend/step7.spec.ts --workers=2 --retries=0` | 12/12 本轮定向通过 |
| `npm run test:desktop -- --retries=0` | 86/86 通过 |
| `node test/backend/run-step7-real-codex.mjs` | 27/27 直接 CLI 检查通过；内嵌正式 ChatService R2 探针 88/88 通过（同 thread A→B→A、F1 准备互斥、F2 退出确认、重启、并发与审批） |
| `node test/backend/run-step7-r2-service.mjs` | 88/88 通过（可单独运行；正式 ChatService + 真实设置保存链 + 真实 Codex/venv） |
| `node test/backend/test-r2-service-gate.mjs` | 32/32 通过（F3 汇总归属/失败/超时/损坏/正常） |
| `node test/backend/run-step6-fixes-probes.mjs` | 通过（R1～R6 回归） |

真实 Codex 探针覆盖：

1. 只读沙箱内写文件被拒绝。
2. 项目内读写沙箱内写成功，命令实际看到 PATH 与工具箱环境变量。
3. 项目外普通写在项目内读写权限下被拒绝。
4. 显式升级请求触发 `item/commandExecution/requestApproval`；批准后写入成功，拒绝后文件不存在。
5. 历史读取后再次写入仍成功；当前正式历史路径使用只读分页接口，不通过 resume 重设 thread 执行配置。
6. 显式选择完全访问后项目外写成功；切回只读后项目外写再次被拒绝。
7. 真实 venv 解释器执行原位 `debug_hello.py`，输出 `CHATFGM_DEBUG_TOOL_OK`、原样中文与 `$;()` 特殊字符，并报告与配置一致的解释器绝对路径。
8. 两个 thread 配置不同 venv 并并发执行，各自命令只看到自己的 `CHATFGM_PYTHON`/解释器，未串环境。
9. 30 秒长命令在 interrupt 后约 0.7 秒以 `interrupted` 结束，app-server 进程仍存活（未杀共享进程）。
10. 已有 thread 通过 `thread/settings/update` 更新 developer instructions，真实上游请求出现新标记，thread id/历史不变。
11. 原位技能 `/debug-hello` 首次请求含 V1 正文，修改 SKILL.md 后同一 thread 下一轮请求只含 V2 当前正文；其他技能正文未注入，原始工具路径执行成功。
12. 真实 Python 父/子进程树写入心跳：turn/interrupt 后 `thread/backgroundTerminals/terminate` 返回 terminated，父子 PID 均退出、心跳停止增长；未终止时心跳继续增长。
13. 已加载 thread 的热字段更新仍诊断失败（`ENV_NAME=env-visible`）；全新进程在稳定历史 home 上 resume 原 thread 并显式提供 B 时，真实命令输出 `env-visible-b`，thread id/历史保留。该结论由正式 ChatService 探针独立验证，不把底层实验或热字段结果当作产品通过。

服务级测试另覆盖：审批身份/决策/重启过期、多请求、`serverRequest/resolved` 收敛底层 pending 与持久化、停止等待审批、权限审批读/写/拒绝/网络/契约 payload、工具环境记录与相关性保护、每对话执行 owner/环境指纹冷恢复、文件同步合并与变更/删除身份、最终同步失败 reject + run 警告、覆盖前二次版本校验、另存不覆盖、20,000 字符工具输出的有界截断、执行会话终止/拒绝终止/停止重试、原位技能正文与修改重读。

UI 新增/更新用例（`test/frontend/step7.spec.ts`）：审批等待/多请求身份/批准拒绝/关闭重开/Esc 暂不处理、权限读/写/网络/范围展示（800/1000/1440）、未绑定工具箱选择与绑定、不同文件并发更新互不取消、同一文件旧响应不覆盖新版本、读取失败自动/手动重试与持久失败、编辑中的读取不覆盖、干净文本外部更新与脏编辑保留、保存冲突取消/重载/再次冲突/确认覆盖、HTML 页面实例保留与更新提示/刷新清除、最终同步失败阻塞关闭并可重试、后台同步失败提示与重试、删除脏文档另存。截图位于 `test/results/screenshots/`，Playwright 失败/跟踪产物位于 `test/results/artifacts/`。

桌面新增用例（`test/desktop/14-step7.spec.ts`）：真实桌面上等待审批→查看审批→批准→运行层收到 accept；真实 Agent 改盘后目录树出现新文件、已打开干净编辑器自动刷新且标签未重开。

正式 ChatService R2 探针（`test/backend/run-step7-r2-service.mjs`，真实 Codex + 本地 Responses 夹具 + 真实 Windows 沙箱/venv）覆盖：同一 thread A→B→A（每轮唯一 RUN_MARKER、真实 CHATFGM_PYTHON/sys.executable/PATH 与环境变量、thread ID/history 不变）；共享服务 config 未被写为 B；先读历史再发送；应用重启后 B；普通未绑定对话绑定工具箱后 cold resume；同一服务另一项目长任务运行期间修改并恢复 P1，P2 owner/心跳/thread 不变；另一对话等待命令审批时恢复 P1，审批仍属于原 owner 且批准后真实文件落地；每轮只有一次 tool call/turn。探针按当轮 newest user message 选脚本、按 call_id 关联 function_call_output，禁止使用历史拼接或全局最后一个 output。F1 使用确定性准备门闩暂停 owner 创建：首次发送和已有 thread 冷恢复期间通过正式 SettingsService 保存同一工具箱环境均被拒绝且持久化值不变，另一工具箱仍可保存；放行后命令仍使用已固定环境。失败、重试和同工具箱两个重叠准备分别验证保护释放与引用计数。F2 在存储测试中覆盖显式 dispose、错误 owner 重建、服务重置，以及真实执行进程 initialize 回执错误：底层 transport 内部 dispose 清空 `pid` 后 Runtime 仍用 `stablePid` 登记 pending；旧 OS 子进程存活时后继 owner/turn 和重复/并发 ensure 均被阻止，其他对话正常；旧进程真实退出后重试恢复原 thread。

## 13 已确认 UI 与前序回归

- 未重新设计聊天面板、设置、任务状态或查看器布局；审批使用现有 Modal 风格，工具箱选择复用同一弹窗语言，新增交互只在既有区域追加必要入口。
- 新增前端行为：运行 trace 的“等待审批”、对话区“查看审批”条与审批弹窗、未绑定工具箱提示与选择、文件冲突弹窗、删除文件后的“另存为”、HTML 外部更新提示。
- 既有流程保持不变：只读对话、历史/停止/后台通知、六类查看器、目录树、工作区恢复、设置、附件/截图、退出协调。
- 第 6 步 R1～R6 的队列、连接归属、写库失败保护、历史读取、并发连接、截图清理均有回归覆盖。

## 14 第 7 步当时的外部受限与未验证事项（历史）

本节记录第 7 步结束时的状态。账号相关限制已由下方“真实在线验收记录”补充；硬件矩阵、专业算法及未实测的模型组合仍不能推断为通过。

- 真实 DeepSeek 在线模型发现/Responses/图像输入：没有用户明确提供的隔离 Key；未读取、解密或复用其他 agent/用户凭据。
- 真实 ChatGPT OAuth 成功、登录保持和已登录退出：账号停用；未发起新的 OAuth。协议夹具不代表真实在线账号通过。
- 真实在线模型下的多轮复杂工具编排、真实专业 FGM 求解/建表/后处理/报告：本步只验证通用执行与环境链路，专业算法继续由工具箱承载，未以测试夹具冒充真实求解结果。
- 副屏截图、100%/125% DPI、`desktopCapturer` 硬件/权限失败路径：当前单显示器、150% DPI。
- 原生系统文件选择对话框的人工点击：自动化通过主进程返回注入选择结果；后续真实读取、校验、复制、数据库和发送均走产品代码。
- production 真实 `%APPDATA%\ChatFGM` 数据目录未在自动化中启动。
- 超长真实服务历史（>500 turns / 20,000 items / 64 MiB）只验证有界错误设计，未构造超大真实历史。
- Windows 沙箱在其它 Windows 版本/策略下的初始化结果不同；本机 0.165.0-alpha.1.2 + `experimental_windows_sandbox` 已验证实际写权限、拒绝与审批行为。`updateRequired`、setup 失败和写沙箱不可用的分支按代码路径实现并明确报错，但本机实际状态为 ready，未在真实需要更新或初始化失败的 CLI 上复现。
- 已有 thread 的热更新限制仍然存在：已加载进程内 resume/settings/config 热重载不改变 shell 环境；此前“全新进程 resume 也无效”的结论来自拼接历史和复用旧工具输出的错误探针，已撤销。正式 ChatService 冷恢复探针证明新进程在原 thread 上使用 B，并保留历史和 thread ID。

## 15 验收缺陷修复（2026-11-01）

| 缺陷 | 根因 | 修复与证据 |
| --- | --- | --- |
| R1 文件夹名未贯通配置 | `settings/store.ts` 仍用 ASCII `TOOLBOX_ID`，中文/空格/数字开头被 `invalid-settings` | 新增 `toolboxes/name.ts` 合法 Windows 文件夹名校验，设置保存/加载、IPC、项目创建/绑定共用；支持“中文工具箱”“Python Tools”“123Flame”，拒绝路径穿越/设备名/尾随点空格，大小写重复按 Windows 语义拒绝。存储测试 `toolbox-folder-names-roundtrip...`、`ipc-rejects-toolbox-path-traversal...` 通过。 |
| R2 已有 thread 不更新环境/说明 | CLI 0.165 对已加载 thread 忽略 `thread/resume` 的 config/说明，`thread/settings/update` 和 `config/batchWrite` 热重载也不改变 shell 环境；此前“新进程恢复也无效”的结论是错误探针输出造成的 | 说明：已有 owner 用 `thread/settings/update` 的 `collaborationMode.settings.developer_instructions` 更新，真实上游请求含标记。环境：服务认证/模型上下文共享，执行连接按对话归属；检测到指纹变化时只结束目标对话 owner，在稳定历史 home 用原 threadId 冷恢复并传当轮 `shell_environment_policy.set`，回执 thread id 必须一致。正式 ChatService 探针完成同一 thread A→B→A、重启后 B、真实 venv 解释器/环境变量、并发另一运行与审批隔离；热更新字段仍保留为诊断，不作为产品通过依据。发送准备引用保护覆盖首次发送、已有 thread 冷恢复和重叠准备；旧执行进程退出超时会保持 pending 身份并阻止后继 owner，真实退出后才允许恢复。 |
| F3 综合探针归属 | 扫描全局最新 R2 报告，当前子进程失败也可能读取旧成功报告 | 父进程分配唯一 `r2-service` 结果目录并传给子进程；共享 `r2-service-gate.mjs` 校验当前退出码/启动错误/超时/报告路径归属/完整性/result 状态/有限非负整数计数/非空 checks/每项名称与状态/计数一致性；缺失、损坏、旧报告、非零退出、notRun、结构或计数不符均失败。正常综合运行与 32 个正反夹具通过。 |
| R3 停止未结束 Python 链 | 只映射 `turn/interrupted`，未管理 CLI execution session | turn 终态后按本 run command item 调用 `thread/backgroundTerminals/list` + `terminate`，轮询确认；失败保持 unknown 并显示原因，停止调用本身返回明确错误，重试停止可收敛。真实 Python 父子进程心跳/PID 证据；存储测试覆盖自然结束、拒绝终止、停止重试。 |
| R4 显式技能未加载/缺失静默发送 | 传给 CLI 的是目录；未注册技能不会被 CLI 注入；技能缺失后 registry 删除目录，显式调用退化为普通消息 | 新增 `backend/chat/explicit-skill.ts`：仅显式 `/技能名` 时读取原位 SKILL.md（128 KiB 上限、普通文件/路径 containment）并作为该次请求上下文发送，附原始目录；技能不存在/删除/不可读/名称无效均抛出明确错误，并在 submission/turn 之前校验，返回 not-sent、不创建 turn。真实 CLI 上游请求含 V1/V2 标记且工具原位执行；正式 ChatService 测试覆盖缺失→错误→修复重试。 |
| R5 审批传输身份隔离不完整 | `request.respond/reject` 只闭包 key，同 ID 后继请求会被旧回调操作；resolved 未核对 thread | 回调捕获原始 `PendingServerRequest` 状态，settle 要求 `pendingServerRequests.get(key) === state`；resolved 同时核对请求 params 的 thread。旧对象答复/拒绝返回 false 不写 RPC，不相关 thread 不清理；新增同 ID 复用、错误 thread、ChatService 旧审批/新审批测试。 |
| R6 权限展示不全 | 只收集路径，丢弃读写区分、网络和命令附加权限 | `ChatApprovalPermissions` 结构化展示读/写/拒绝路径、network、host/protocol、scope；命令 `additionalPermissions` 与 `networkApprovalContext` 一并展示。批准回显原始 profile，展示与 payload 精确一致；不支持结构直接拒绝。800/1000/1440 权限弹窗截图与断言。 |
| R7 多文件失败恢复状态被覆盖 | 只保存一个 `externalReadFailureKeyRef`，提示条只对应最后失败文件，恢复后隐藏其他失败 | 改为 `Map<projectId+identity, failure>`，提示条汇总所有未恢复文件；重试读取会逐项重试，单个成功只移除自身，仍有失败时提示条保留；实例/项目/编辑/删除校验继续阻止迟到恢复。前端新增多文件失败、恢复后剩余入口、最终清除测试。 |
| R8 重叠最终同步提前成功 | `finishWaiters` 的 `final` 让后一次 finalize 被更早扫描成功结算，补扫失败无法传播 | 每个 finalize 分配 request sequence，等待者只有在“开始时间 ≥ 该请求”的扫描成功后才 resolve；在途扫描后的请求强制补扫；补扫失败 reject；后台合并仍保持一个在途/一个排队。新增重叠 finalize、补扫失败、恢复、dispose 等待者测试，关闭流程等待 `flushProjectSync`。 |

## 16 第 7 步外部受限与在线边界补充（历史）

- R2 的环境切换不再依赖修改共享配置或新建对话：服务上下文与执行 owner 分离，环境变化只冷恢复目标 thread。已记录 `thread/resume` 的 config/说明、`thread/settings/update` 的未文档化环境字段、`config/batchWrite` 热重载、全新 app-server 进程 resume 等原始输出；新进程 resume 成功是产品路径，旧“新进程也无效”结论已更正。
- 新 R2 真实证据使用 `test/backend/run-step7-r2-service.mjs`，在同一正式 ChatService/设置保存链中完成 A→B→A、重启、并发和审批场景；旧的仅调用底层 resume 实验和拼接历史探针只作为历史诊断，不再作为产品通过证据。
- 本轮新增真实证据均在 `test/results/main-review-step7-20261101-100754/` 之外的独立 `test/results` 目录；主 agent 的验收记录与截图未被删除或覆盖。
- 真实在线 DeepSeek/ChatGPT 账号、真实 FGM 专业算法仍不在本轮通过范围；本地 Responses 夹具只证明协议、CLI、沙箱和进程行为，不代表在线模型通过。




















## 第 8 步审查整改说明

IPC 的项目、能力和工作区契约统一归属 `backend/ipc/`；前端原路径仅兼容重导出，不改变界面行为。后端不再反向依赖 `app/services` 类型。

执行准备测试门闩、配置重载诊断调用和本地 Responses 地址替换均位于 `test/`；正式 DeepSeek 配置只生成官方地址。模型 catalog 构造函数由真实发现路径复用。退出确认预算保留为正常超时注入：到期只报告未确认退出并保留 pending，不改变实际退出判定。测试模式的目录隔离和失败弹窗抑制不改变启动失败退出码。

审批保留完整命令；无法完整解释的权限字段沿用拒绝路径，不能批准界面未表达的权限。第 8 步本轮命令与结果以独立 `test/results/step8-*` 证据为准；历史通过记录不替代本轮复测，在线账号验证也不能由本地协议夹具替代。

真实在线联调补充：轮次结束后，缺少终态证据的工具条目记为 `unknown`，不能继续显示为 `running`，也不能推断为成功；迟到输出遵守同一规则。历史核实为终态后清除应用生成的重启待核实摘要，保留真实执行错误与持久化失败信息。在线联调及本次修正的证据单独保存在 `test/results/online-integration-*`，服务端拒绝、预期失败和测试控制器错误分别记录。

## 真实在线验收记录与再次审查

2026-11-01 用户在隔离窗口配置 ChatGPT 登录和 DeepSeek Key，真实官方服务实测模型为 `gpt-5.6-terra` 与 `deepseek-flash`。已验证发送、原位 debug-hello、配置解释器、文件产物、原 thread 续聊、真实停止、审批批准/拒绝及恢复；原始证据和限制见 `test/results/online-integration-2026-11-01T14-10-52-142Z/online-acceptance-report.json`。GPT-6-Luna 的服务端拒绝保留为失败，不计作通过。账号已退出，API 配置和密钥记录已删除；不能把历史在线证据描述为此后的重新登录或重新付费调用。

再次源码审查发现历史分页主路径未累计 item 数量，且重复游标可持续请求。已在每页响应后检查累计数量、字节量、页数和游标推进；异常明确失败，保留本地历史供重试，不读取完全部远端内容后才限额。新增回归覆盖超限、重复游标与正常跨轮分页，测试位于 `test/backend/history-bounds-checks.ts`。
