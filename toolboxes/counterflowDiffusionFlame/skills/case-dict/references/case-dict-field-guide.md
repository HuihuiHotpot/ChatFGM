# Case Dict Field Guide

## Top-Level Fields and Their Roles

- `workflowState` 记录最近实际启动的执行阶段。
- `caseMeta` 记录算例名称、标签、备注和固定单位约定。
- `intent` 记录算例目标、目标输出、主要假设、已知限制、待确认事项和重要决策。
- `mechanism` 记录原始机理所在目录，以及反应机理和零反应机理的产物路径。
- `boundaryConditions` 记录燃料和氧化剂的组成及其基准、参数扫描或显式指定的入口工况，以及稳态延拓的应变率序列。
- `numericalSetup` 记录混合线、瞬态着火、稳态延拓和 FFM 的数值设置，包括时间步、剖面保存和并行配置。
- `tabulation` 记录 FGM 数据库的查表轴、输出变量、进度变量定义和制表网格。
- `validation` 记录先验验证所需的工况和剖面选样设置，用于检查正式表对已有火焰面剖面的复原效果。
- `report` 记录报告的标题、语言、输出路径和章节安排。
- `errors` 记录错误现象、所属阶段、处理状态、阻塞情况、影响范围、证据、处理措施和验证结果，以及错误汇总。
- `extensions` 暂存现有字段尚未覆盖的算例特有设置。

## Stage Entry Conditions

准备进入或继续某个阶段时，对照本节中该阶段的准入条件，确认 `caseDict` 中所需的设置已明确，所需输入文件和上游产物齐备，且适用于该阶段拟开展的工作。本次工作暂不需要的设置、文件和产物可以暂缺。

### 进入 Stage A：机理准备

- `intent.userIntent` 已明确算例目标，`intent.targetOutputs` 已明确目标输出。
- `caseDict` 中已分别列明燃料侧和氧化剂侧的物种名称。
- `mechanism.sourceDirectory` 已记录原始机理所在目录，所需原始文件已提供且可读取。

### 进入 Stage B：火焰面计算

- 本次工作需要使用机理文件时，所需机理文件已准备完成，可按 `caseDict` 中对应的预设路径读取，且适用于拟开展的工作。
- 涉及火焰面求解时，`boundaryConditions` 中已明确燃料侧和氧化剂侧的入口组成，以及两侧共用的组成基准。
- 依赖已有结果时，所需结果文件可读取，结果来源和对应工况已核对，且包含拟执行的计算或后处理所需的数据。

### 进入 Stage C：制表

- 有可供本次工作使用的火焰面结果或已有制表产物，所需文件可读取，来源和对应工况可核对。
- 进入 Stage C 后，由制表 skill 根据用户目标和已有产物确定执行起点，并核对拟执行步骤所需的设置和输入。

### 进入 Stage D：先验验证

- 开展先验验证时，已有可供选择的 Stage C 制表工况。这些工况的 `Z–C` 表、对应的 `Yc` 上下界及 `C-tabulation/01-prepared_samples/` 中的制表样本均可读取。
- 仅查看、分析或核对已有验证结果时，确认本次所需的结果可读取。

### 进入 Stage E：报告编写

- 用户已提出编写报告的需求，且有可供本次报告使用的算例记录或已有产物。

## Field Guidance

### 填写原则与判断方法

先明确一项信息的含义和适用范围，再按字段职责找到对应位置。如果现有信息有多种合理解释，且不同解释会影响当前步骤，说明差异并提出建议，请用户确认。

- 优先使用现有字段和模板预留的条目结构，沿用标准模板的字典格式、字段名称、层级和注释结构。需要补充解释时，使用注释或已有的说明字段。
- 确需记录且现有结构无法表达的算例特有设置，可暂存于 `extensions`。
- 带单位的量按 `caseMeta.units` 的约定填写。模板未约定的量，在其定义中注明单位。
- 修改后核对括号、分号、列表和注释结构，并检查相关字段是否一致。

### `workflowState`

`workflowState` 记录最近实际开始执行的建库阶段。

- `0` 表示尚未开始任何执行阶段。
- `A` 表示机理准备。
- `B` 表示火焰面计算。
- `C` 表示制表。
- `D` 表示先验验证。
- `E` 表示报告编写。

实际启动某个执行阶段时，先写入对应值，再开始该阶段的工作。收集信息、调整设置、检查准入条件或等待执行时，沿用原值。同一阶段内的各子步骤共用该阶段的值。

阶段可跳跃、回退或重做。每次实际启动时，直接写入该阶段值。能否继续，按下一步的准入条件判断。阶段交付的完成状态记录在 `extensions.completedWorkflowStages`。

### `caseMeta`

- `caseName` 记录算例名称。
- `tags` 记录用于归类或检索算例的标签。
- `notes` 记录一般备注。各阶段预设步骤之外的后处理，如有交付文件，在此简要记录所用数据、处理内容和保存路径。主要假设、已知限制和重要决策各自写入 `intent` 中的对应列表。
- `units` 由标准模板预先设定，规定算例采用的固定单位。

| `units` 中的字段 | 对应的量 |
|---|---|
| `length` | 长度和空间坐标 |
| `time` | 时间和时间步长 |
| `temperature` | 温度和温差 |
| `pressure` | 压力 |
| `strainRate` | 应变率 |
| `density` | 密度 |
| `molecularWeight` | 摩尔质量 |
| `moleFraction` | 摩尔分数 |
| `massFraction` | 质量分数 |
| `progressVariable` | 归一化前的进度变量 |
| `mixtureFraction` | 混合分数 |
| `normalizedProgressVariable` | 归一化进度变量 |
| `speciesProductionRate` | 按物质的量计的物种生成率 |
| `progressVariableSource` | 按质量计的进度变量源项 |

### `intent`

- `userIntent` 记录用户希望通过算例解决的问题和达到的目标。
  入口组成尚未填写时，可在此补记用户已确认的物种名称，并注明属于燃料侧还是氧化剂侧，供 Stage A 核对原始机理。
- `targetOutputs` 记录用户期望获得的成果。具体的制表输出变量、绘图要求和报告章节分别写在对应的设置字段中。
- `primaryAssumptions` 记录算例采用的物理假设和工程简化。保留模板中各物种 Lewis 数均为 1 的假设，并补记本算例采用的其他假设。
- `knownLimitations` 记录已知限制，并说明它们对结果适用范围或结论的影响。
- `openQuestions` 记录当前步骤所需且必须由用户确认的事项。事项明确后，将确认结果写入对应字段，并从待确认列表中移除。
- `decisionLog` 追加重要的方法选择和方案变更，记录决定内容、依据和适用范围。常规的参数澄清直接更新对应字段，需要追溯选择依据时再写入决策记录。重做并沿用原产物路径时，若已有决策记录引用了旧产物，在本次变更记录中注明旧产物的原路径，以及归档位置或删除情况。

`knownLimitations`、`openQuestions` 和 `decisionLog` 没有相应记录时，保留空列表 `()`。

### `mechanism`

- `sourceDirectory` 记录用户提供的原始机理文件所在目录。
- `reactiveFile` 记录反应机理的 Cantera YAML 文件路径，用于反应计算。
- `nonReactiveFile` 记录零反应机理的 Cantera YAML 文件路径，用于非反应计算。

`reactiveFile` 和 `nonReactiveFile` 的路径已在标准模板中预先设定，生成两类机理产物时直接沿用。

### `boundaryConditions`

- `fuelComposition` 和 `oxidizerComposition` 分别记录燃料侧和氧化剂侧的物种组成。
- `compositionBasis` 记录两侧共用的组成基准，可取 `moleFraction`（摩尔分数）或 `massFraction`（质量分数）。

入口工况有两种写法，择一使用。两种写法都沿用上面的组成设置。

- **参数扫描**填写 `fuelTemperature`、`oxidizerTemperature`、`pressure` 和 `transientStrainRates` 四个列表，分别记录燃料入口温度、氧化剂入口温度、压力和瞬态应变率。每个列表是一条独立的取值轴，工况由四个列表的笛卡尔积生成。
- **显式工况**填写 `operatingConditions`。每个命名条目定义一个完整工况，包含 `fuelTemperature`、`oxidizerTemperature`、`pressure` 和 `transientStrainRate`。

`continuationStrainRates` 记录已着火工况进行稳态延拓时采用的目标应变率序列。各目标值以 `1/s` 为单位，填写为整数，并按严格降序登记，例如 `(250 200 150)`。列表顺序即实际求解顺序。对每个工况，按该顺序依次求解小于或等于该工况初始应变率的目标。

### `numericalSetup`

`mixingLine`、`ignition`、`continuation` 和 `ffm` 分别记录非反应混合线、瞬态着火、稳态延拓和 FFM 的数值设置。标准模板中的默认数值设置适用于本次计算时，可以直接沿用。

#### 时间步长

- 四个设置块中的 `globalTimeStep` 记录对应计算的全局时间步长。`ffm.globalTimeStep` 用于零反应松弛计算。
- `ffm.initialGlobalTimeStep` 记录 FFM 燃烧稳态初始化时的全局时间步长。

#### 剖面保存

- `ignition.profileSaving` 中的 `startupDeltaTThreshold` 和 `regularDeltaTThreshold` 分别记录启动阶段和常规阶段触发剖面保存的温差阈值。
- `ffm.profileSaving` 中的 `deltaTmaxThreshold` 记录当前剖面与上一保存剖面之间的峰值温度差阈值。`rmsDeltaTThreshold` 记录这两个剖面在相同混合分数网格上的温度差均方根阈值。
- 两个 `profileSaving` 块中的 `nZPoints` 都记录用于监测温差、判断剖面保存时机的混合分数方向网格点数。

#### 并行设置

四个设置块使用相同的 `parallel` 字段结构。

- `enabled` 用 `true` 或 `false` 表示是否启用并行。
- `nWorkers` 记录最多同时计算的工况数量。
- `nThreadsPerWorker` 记录每个工况使用的求解线程数。

只为部分工况调整参数时，在相应的决策或错误记录中注明实际取值和适用工况。

### `tabulation`

#### 查表轴 `lookupAxes`

- `axes` 按查表顺序记录完整的轴标识列表，包含混合分数 \(Z\) 和归一化进度变量 \(C\) 对应的轴。其余轴按本次制表需求确定，用于区分制表工况。
- `definitions` 为 `axes` 中的每个标识记录一个同名条目。条目中的 `definition` 写明该轴的物理定义。该轴的单位未在 `caseMeta.units` 中约定时，用 `unit` 补充。轴的物理含义以 `definition` 为准。

#### 输出变量 `outputVariables`

- `progressVariableSource` 固定填写 `true`。本工具箱在每个工况的制表结果中保存进度变量化学源项 `omega_Yc`，单位为 `kg/(m^3*s)`。FFM 松弛采用零反应机理，该字段保留，值为零。
- `speciesMassFractions` 用 `all` 或明确的物种列表指定保存哪些物种的质量分数。
- `additionalVariables` 记录额外输出量的标识列表。
- `definitions` 为 `additionalVariables` 中的每个标识记录一个同名条目。条目中的 `definition` 写明该输出量的物理定义。该量的单位未在 `caseMeta.units` 中约定时，用 `unit` 补充。

#### 进度变量 `progressVariableDefinition`

- `definition` 用 `Yc = ...` 的公式记录进度变量的物理定义，并说明公式中各符号的含义。系数可保留其物理表达式。
- `names` 按顺序记录用于定义进度变量的物种名称。
- `weights` 记录各物种的无量纲数值权重，与 `names` 按顺序一一对应。

#### 制表网格 `grid`

`Z` 记录混合分数网格，`C` 记录归一化进度变量网格。两者都使用以下字段：

- `nPoints` 记录网格点数。
- `description` 记录网格点的分布方式。描述应足够明确，使制表时能够结合 `nPoints` 生成唯一、可复现的坐标序列。

### `validation`

先从已制表工况中选取代表工况，再为每个入选工况选取适用于该工况的完整参考剖面。结合本次验证关注的工况差异和燃烧过程判断代表性。验证时用对应工况的正式表逐点回查，对比查表值与参考剖面的原始值。

- `nConditions` 记录选取的制表工况数量。
- `conditionSelection` 说明如何从已有制表工况中选取代表工况。可以直接列出工况，也可以结合本次验证目标，按查表轴取值和工况差异说明选取方法。
- `nProfilesPerCondition` 记录每个入选工况选取的完整参考剖面数量。各工况数量相同时，填写一个整数。数量不同时，按 `validation_inputs.json` 中 `cases` 的顺序填写整数列表，例如 `(6 2)`。
- `profileSelection` 说明如何为每个入选工况选取有代表性的完整参考剖面，可结合本次验证目标说明希望覆盖的瞬态着火阶段、稳态延拓应变率或 FFM 松弛阶段。

### `report`

- `title` 记录报告标题。
- `language` 记录报告语言，可取 `zh-CN`（中文）或 `en`（英文）。
- `outputFile` 记录报告文件的输出路径。
- `sections` 记录报告包含的章节及各章节的内容要求。模板预留的章节按本次报告范围选用。

| `sections` 中的字段 | 对应的章节内容 |
|---|---|
| `problemDefinition` | 算例要解决的问题和目标 |
| `assumptions` | 采用的主要假设和简化 |
| `mechanism` | 机理来源、准备过程和核验结果 |
| `boundaryConditions` | 入口条件和所涉及的工况 |
| `numericalSetup` | 实际采用的数值设置 |
| `flameletComputation` | 火焰面计算过程和结果 |
| `tabulation` | 制表方法和数据库内容 |
| `validation` | 先验验证方法和结果 |
| `discussionAndLimitations` | 结果解释、适用范围和已知局限 |
| `conclusions` | 与算例目标对应的结论 |

### `errors`

#### 错误编号与字段

每个错误以独立条目记录。编号从 `error_0001` 起递增并保持唯一。同一个错误在调查、修复和验证过程中沿用原编号。

- `stage` 记录错误所属阶段，可取 `caseSetup`、`mechanism`、`flamelet`、`tabulation`、`validation` 或 `report`。
- `status` 记录当前处理状态。
- `blocking` 用 `true` 或 `false` 表示错误是否阻塞依赖相关设置或产物的工作。
- `affectedCases` 记录受影响的工况标识，适用于能定位到具体工况的错误。
- `message` 说明发生了什么，以及影响了哪些设置、产物或步骤。
- `evidence` 记录相关日志或结果文件相对于算例根目录的路径。
- `resolution` 记录实际采取的处理措施。决定不修复时，说明原因及影响。
- `verification` 记录验证方法、范围和结果。

#### 状态更新

| `status` | 含义 |
|---|---|
| `open` | 错误已记录，尚未处理。 |
| `investigating` | 正在查找原因或确定处理方案。 |
| `fixed` | 已采取修复措施，尚待验证。 |
| `verified` | 修复结果已通过验证。 |
| `wontFix` | 已决定不修复，并记录了原因和影响。 |

修复类错误通常按 `open → investigating → fixed → verified` 更新。采取修复措施后，填写 `resolution` 并更新为 `fixed`。验证后填写 `verification`。验证通过时更新为 `verified`，确认该错误造成的阻塞已消除后，将 `blocking` 改为 `false`。验证未通过时，回到 `investigating`。

#### 阻塞范围

根据当前任务实际依赖的设置和产物，判断某条错误是否阻塞正在检查的步骤。只影响部分工况时，在 `affectedCases` 中标明这些工况。只能定位到设置、产物或步骤时，在 `message` 中说明。其他工作按各自的准入条件检查。

`wontFix` 表示处理决定。是否仍阻塞，由错误的实际影响决定。可继续使用结果、但存在局限时，可在 `intent.knownLimitations` 中说明其适用范围。

#### 错误汇总

`errors.summary` 按错误条目计数。新增条目，或条目的状态、阻塞标记发生变化后，同步更新汇总。

| 字段 | 统计口径 |
|---|---|
| `total` | 全部错误条目的数量。 |
| `open` | 状态为 `open`、`investigating` 或 `fixed` 的条目数。 |
| `blocking` | `blocking` 为 `true` 的条目数，与处理状态分别统计。 |
| `resolved` | 状态为 `verified` 且 `blocking` 为 `false` 的条目数。 |
| `lastErrorId` | 当前编号最大的错误条目标识。没有条目时填 `none`。 |

状态为 `wontFix` 的条目计入 `total`，不计入 `open` 或 `resolved`。是否计入 `blocking`，取决于该条目的阻塞标记。`open` 必须按条目状态直接统计，不能用 `total - resolved` 推算。

`summary.blocking` 给出算例中阻塞条目的总数。判断某一步能否执行时，应查看相关错误条目的实际影响范围。

### `extensions`

`completedWorkflowStages` 是可选列表，例如 `completedWorkflowStages (A B);`。仅在核对实际产物和检查结果、确认阶段交付已覆盖当前算例范围后，写入对应的 `A`–`E` 值。各值只记录一次。仅完成部分子步骤时，等该阶段交付核验完成后再记录。列表缺失或为空时，表示没有完成记录。

重做、配置变更或上游产物变更后，核对当前阶段和依赖它的其他阶段。发现旧交付失效时，移除对应值。仍适用的交付保留其完成记录。重做后经核验确认完成，再写入该值。根据实际产物维护列表，`workflowState` 只记录最近启动的阶段。

暂存确需随算例保存、且现有字段和模板预留结构无法表达的算例特有设置。

每项设置写明名称、含义和取值，并注明适用范围。涉及有量纲的数值时，注明单位。
