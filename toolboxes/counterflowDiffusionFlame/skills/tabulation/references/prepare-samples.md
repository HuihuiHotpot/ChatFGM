# 01 准备制表样本

按工况逐条处理 Stage B 原始剖面，在原空间网格上计算 `Yc` 和进度变量源项，并准备本次制表所需的其他字段。每条原始剖面生成一份样本，供 `02` 沿 `Z` 插值使用。

## Inputs

- **制表清单和剖面**。使用 `B-flamelet/05-postprocess/tabulation_manifest.json`。每个选定工况都使用清单列出的全部原始剖面。
- **反应机理**。使用与剖面配套的 `caseDict.mechanism.reactiveFile`。
- **制表设置**。从 `caseDict.tabulation` 读取以下设置。
  - `progressVariableDefinition` 给出制表采用的 `Yc` 公式、物种名称和对应权重。
  - `outputVariables` 给出要保存的物种质量分数及额外输出量的定义和单位。
  - `lookupAxes` 给出查表轴的顺序、定义和单位，用于确认各制表工况对应的轴值。

## Execution

### 1. 确定查表轴和输出量的取值方式

从 `tabulation.lookupAxes` 读取 `Z` 和 `C` 之外的查表轴，从 `tabulation.outputVariables` 读取拟保存的物种质量分数和额外输出量。对照[原始剖面字段](profile-fields.md)，按物理定义、单位和取值位置确定数据来源。

- **直接取值。** 已有字段符合所需定义时，确定使用哪个数据集、取哪个位置的值，以及是否需要换算单位。例如，工况压力可读取标量 `P`，逐点温度可读取 `T`，指定物种的质量分数可按机理中的物种顺序从 `Y` 提取。
- **派生计算。** 需要根据已有数据计算时，先明确计算方法、所需字段和输出单位，并核对本次选定的剖面和配套机理能否提供这些输入。例如，逐点混合物比焓可用原始剖面的 `T`、`P`、`Y` 和配套机理求得。需要编写派生脚本时，按下一步处理。
- **待确认的量。** 现有数据不足或定义有歧义时，说明具体缺项，请用户补充或调整设置，并通过 `case-dict` 更新 `caseDict`。确实无法取得的量，经用户确认后从制表设置中移除。更新后回到本步重新核对，确认所需量均可读取或计算后，再准备样本。

对 `Z` 和 `C` 之外的查表轴，确定每个工况对应的轴值、单位和来源，样本生成后写入该工况的 `case.md`。

### 2. 准备派生变量脚本（按需）

有需要逐条剖面计算的派生量时，根据上一步确定的计算方法，参考 [derive_variables.py 模板](../../../tools/tabulation/prepare_tabulation_samples/derive_variables.py) 编写 `C-tabulation/derive_variables.py`。按[派生变量脚本编写原则](python-scripting.md)完成编写和试算核对。

### 3. 运行样本准备工具

在当前算例根目录，使用 ChatFGM 工作台配置的 Python 调用工具。`$caseName` 使用制表清单中的完整工况名，`$reactiveFile` 取自 `caseDict.mechanism.reactiveFile`。`$progressSpecies` 和 `$progressWeights` 分别取自 `tabulation.progressVariableDefinition.names` 和 `weights`，按原顺序传入。

构造 `$progressWeights` 时，将各权重按原顺序写成普通十进制字符串。例如，权重为 `-1E-06` 和 `1.0` 时，使用 `@('-0.000001', '1.0')`。

以处理一个工况为例。

```powershell
& $env:CHATFGM_PYTHON (Join-Path $env:CHATFGM_TOOLBOX_DIR 'tools/tabulation/prepare_tabulation_samples/prepare_tabulation_samples.py') `
    --case $caseName `
    --mechanism $reactiveFile `
    --progress-species @progressSpecies `
    --progress-weights @progressWeights
```

按本次范围和输出要求调整参数。

- 处理多个选定工况时，每个工况传一次 `--case`。处理清单中的全部工况时，可省略该参数。
- 保存物种质量分数时，从 `tabulation.outputVariables.speciesMassFractions` 读取设置，通过 `--output-species` 传入 `all` 或物种列表。
- 直接提取原始剖面中的额外字段时，每个字段传一次 `--field`，依次给出输出字段名、原始 HDF5 数据集名和该数据的单位。
- 使用派生脚本时，传入 `--derive-script 'C-tabulation/derive_variables.py'`。

## Result Verification

1. 检查工具退出码。运行成功后，到 `C-tabulation/01-prepared_samples/<case_name>/` 核对样本，确认清单中列出的每条剖面都有对应的 HDF5 文件。
2. 抽查样本，确认 `source_profile` 指向对应的原始剖面，逐点数据沿用原网格顺序，输出字段和单位符合本次制表设置。
3. 在各工况的 `case.md` 中补充 `Z` 和 `C` 之外各查表轴的取值、单位和来源。

**预期交付**为各工况核对通过的 HDF5 样本和对应的 `case.md`。样本供后续制表使用，首先作为 `02` 沿 `Z` 插值的输入。

## Failure Handling

发现调用失败，先告诉用户目前看到的问题、影响范围，以及接下来准备检查什么。

- **工具调用失败**。查看 `stderr`，根据报错核对调用参数、制表清单、原始剖面、机理或派生脚本。暂停依赖受影响样本的后续步骤。

向用户说明排查结果和处理建议。需要用户补充信息或确认方案时，按工具箱 `AGENTS.md` 的规则与用户确认，再按确认的范围处理。通过 `case-dict` 更新相关错误记录和已确认的算例设置。

问题解决后，已完成且核对通过的工况直接复用，用 `--case` 指定仍需准备样本的工况。需要重做已有样本时，按主 skill 的[已有产物的核对、复用和重做](../SKILL.md#已有产物的核对复用和重做)处理。核对重做结果后，检查受影响的下游产物。