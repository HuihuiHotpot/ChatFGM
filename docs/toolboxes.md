# ChatFGM 工具箱约定

工具箱位于应用根目录的 `toolboxes/` 下。工具箱类型完全由该目录下一级文件夹的名称决定：文件夹名同时是稳定类型标识和界面显示名称。中文、英文及带空格的合法 Windows 文件夹名均可使用。

不存在 `toolbox.json` 或其他必需 manifest；新增工具箱只需建立符合本约定的文件夹，刷新设置或重新打开新建项目表单即可发现，不需要修改前端类型列表。

## 目录结构

```text
toolboxes/<工具箱文件夹名>/
  AGENTS.md                  工具箱专业说明（可选，但建议提供）
  skills/<技能目录>/SKILL.md  技能说明，frontmatter 提供 name/description
  tools/                     专业脚本与实现
  standardCase/              新建项目时初始化到用户所选文件夹的模板
```

- `standardCase/`、`AGENTS.md`、`skills/`、`tools/` 都保持在工具箱原位读取。
- 不复制到项目目录、应用缓存或 `CODEX_HOME`，不安装到项目技能目录，不建立快照或版本副本。
- 不覆盖项目已有的 `AGENTS.md`，也不修改用户全局技能目录或全局 Codex 配置。
- `standardCase` 只在新项目创建流程中复制到用户选择的文件夹；目录非空时必须由用户明确确认覆盖。这是项目模板初始化，不是 Agent 资源安装。模板可用 `.gitkeep` 占位空目录；初始化会创建目录但不复制占位文件。
- 链接/junction 会导致对应工具箱被拒绝；单个工具箱资源损坏只报告该工具箱的具体原因，不影响其他工具箱。

## 原位加载与进程内缓存

项目绑定工具箱后：

1. 创建、打开或绑定项目时，后端按工具箱文件夹名加载一次并放入本次应用运行的进程内缓存。缓存包含工具箱目录、`AGENTS.md` 正文、技能名称/描述/`SKILL.md` 真实路径和 `tools` 目录。同一工具箱由多个项目或对话使用时复用同一份缓存；后续普通消息不重新扫描工具箱，也不重新读取 `AGENTS.md`。
2. 按绑定的文件夹名定位工具箱；文件夹被删除或改名时明确报告缺失，不会自动绑定其他类型。加载失败会明确报错且不写入缓存、不留下半成品；修复后重新打开项目或重启应用即可再次尝试。
3. 技能正文不预加载。普通消息只使用缓存中的技能名称、描述和真实路径；模型按任务需要读取完整技能。用户以 `/技能名` 显式调用时，应用仍读取当前原位 `SKILL.md` 正文（128 KiB 上限）并作为该次请求上下文发送，附原始路径；不复制、不安装、不注册全局技能，不会把其他技能正文批量注入普通消息。原生 CLI 的 `{type:"skill"}` 输入只对已注册技能有效，因此不能只传目录。
4. 技能中的相对资源路径以对应 `SKILL.md` 所在目录解析；脚本继续在原位执行，不预加载全部技能正文，也不建立工具箱快照或版本副本。
5. 工具箱资源（`AGENTS.md`、`skills/`、`tools/`、`standardCase/`）修改后由用户重启应用生效：不实现文件监控、自动刷新、焦点检查或新的刷新按钮，退出应用即释放缓存。设置页和新建项目表单的发现扫描仍按当前磁盘读取 `toolboxes/`，只用于发现文件夹和报告损坏，不会改变本次运行已加载项目的执行缓存。

## Python 环境

每个工具箱在“依赖设置 → Flamelet 工具箱”中配置一个 venv 或 Conda 环境根目录，不新增独立求解器配置。

- 后端解析环境内的真实解释器绝对路径，不退回系统 Python。
- 检测验证解释器可运行、属于所选环境并返回版本；不再要求 `probeScript`、最低/最高版本或 `requiredModules`。
- 发送路径复用环境解析和依赖设置中已完成的检测结果，不再为读取版本同步启动 Python；显式修改环境配置后缓存失效，下一次发送重新解析环境并按现有冷恢复逻辑更新受影响 thread 的执行环境。
- 每次提交把该环境通过 thread 配置的 `shell_environment_policy.set` 传递：`PATH` 前置环境目录，并设置 `CHATFGM_PYTHON`（真实解释器）、`CHATFGM_TOOLBOX`、`CHATFGM_TOOLBOX_DIR`、`CHATFGM_PROJECT_ROOT` 等标识；不修改共享 app-server 进程的全局 PATH。
- **同一 thread 的环境更新通过冷恢复完成**：本机 Codex 0.165.0-alpha.1.2 已加载 thread 内 `thread/resume`/`thread/settings/update`/`config/batchWrite` 热重载都不改变其 shell 环境；但服务上下文共享、执行连接按对话归属后，应用只结束目标对话的执行 owner，在稳定历史 home 用原 thread ID 冷恢复，并在 resume 时传入新的 `shell_environment_policy.set`。基础配置可仍为 A，B 由 resume 显式提供；thread ID、历史和消息顺序保留。其他对话、审批和服务认证进程不受影响。不得把新建对话描述为环境切换，也不得修改共享配置来“切换”。详见 `docs/backend-development.md` 第 8 节与第 15 节。
- 正式工具执行不套用环境检测的短超时；专业依赖写在技能中，由 Agent 按需检查，缺失时说明原因，不自动安装。
- 环境路径或解释器缺失、实际解释器指向环境外时明确报错。

示例技能调用（PowerShell，`freelyPropagatingPremixedFlame` 调试技能）：

```powershell
& $env:CHATFGM_PYTHON "<工具箱绝对路径>\tools\debug_hello.py" --message "你好，ChatFGM"
```

## 当前内置工具箱与调试技能

### `counterflowDiffusionFlame`

该工具箱面向一维对冲扩散火焰的 FGM 建库，流程从算例设置覆盖到机理准备、火焰面计算与后处理、制表、先验验证和报告。`0-caseDict/caseDict` 是算例的唯一事实源。

- `case-dict` 澄清算例目标和预期产出，初始化、维护和检查 `caseDict`，核对各阶段的准入条件，记录假设、待确认事项、决策、执行状态和错误。
- `mechanism` 核对 CHEMKIN 三件套（主机理、热力学和输运）或包含相应数据的 Cantera YAML，生成并核验反应机理和零反应机理 YAML，默认输出到 `A-mechanism/`。
- `flamelet-computation` 在 `B-flamelet/` 中计算非反应混合线和瞬态着火，按着火判定结果进入稳态延拓或冻结火焰面（FFM）。火焰面后处理已并入该技能，涵盖剖面质量检查、结果汇集、补写 Bilger 混合分数 `Z`、通过 HTML 查看器查看剖面，以及筛选制表样本并生成 `tabulation_manifest.json`。
- `tabulation` 在 `C-tabulation/` 中可选做候选进度变量 `Yc` 的单调性预实验。正式制表按工况准备火焰面样本，沿 `Z` 插值、计算 `Yc` 上下界、归一化得到 `C` 并沿 `C` 插值，交付各工况的 `Yc` 上下界和 `Z–C` 热化学表。
- `validation` 从制表样本中选取代表性参考剖面，逐点回查对应工况的 FGM 表并计算误差，在 `D-validation/` 下生成 JSON 结果和 HTML 先验验证报告，说明表的适用范围及是否需要重做。
- `report` 根据 `caseDict` 和已有产物确定报告范围，整理计算设置、结果和有来源记录的图表，在 `report.outputFile` 指定的位置生成并核对 Markdown 建库报告或阶段总结。

`standardCase/` 提供 `0-caseDict/caseDict`、`A-mechanism/` 到 `E-report/` 的阶段目录、`B-flamelet/05-postprocess/flamelet_viewer.html`，以及 `C-tabulation/00-yc_pretest/` 下的预实验输入和 HTML 页面。`E-report/` 在模板中为空，报告编写时按算例设置生成。

### `freelyPropagatingPremixedFlame`

该工具箱仍是调试骨架，提供 `skills/debug-hello/SKILL.md` 和 `tools/debug_hello.py`，用于验证技能加载、解释器与工具执行链路。

调试技能成功时输出 JSON：`{"status":"ok","marker":"CHATFGM_DEBUG_TOOL_OK","message":"..."}`。返回的标记与文字必须来自真实执行，不能由模型自述代替。该调试示例不是 FGM 求解结果；专业求解、建表、后处理和报告算法继续放在各工具箱中。
