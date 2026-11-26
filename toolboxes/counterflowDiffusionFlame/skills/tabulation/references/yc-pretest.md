# 00 候选 Yc 单调性预实验

在代表工况和选定的混合分数 `Z` 处，比较不同候选 `Yc` 随制表剖面顺序的变化，为选择制表采用的进度变量定义提供依据。

## Inputs

- **制表清单和剖面**。从 `B-flamelet/05-postprocess/tabulation_manifest.json` 中选取本次测试的工况。每个选定工况都使用清单列出的全部剖面。确认原始 HDF5 中的混合分数 `Z` 和物种质量分数 `Y` 可读取。
- **反应机理**。使用与剖面配套的 `caseDict.mechanism.reactiveFile`。

## Execution

### 1. 确定测试范围并生成配置

选取工况、观测 `Z` 或提出候选 `Yc` 定义时，可按需检索相关文献和资料，作为判断依据。

1. **选取代表工况。** 用户已指定工况时，按指定范围选取。否则，Agent 从本次拟制表的总体范围和 Stage B 制表清单中，结合入口温度、压力、应变率及已着火或 FFM 分支，选取能反映主要差异的代表工况，并说明依据。

2. **选取观测 `Z`。** 用户已指定观测点时，沿用指定值。否则，Agent 按 Stage B 使用的混合分数定义，根据两侧入口组成确定化学计量混合分数 `Zst`。结合原始剖面和用户关注的区域确定观测点的位置和数量。Agent 自行选取的观测点必须包含 `Zst`，并覆盖贫燃区域和富燃区域。各观测点互不重复，均满足 `0 < Z < 1`。同一份配置中的观测点用于所有入选工况。

3. **确定候选 `Yc` 定义。** 用户已指定候选时，沿用其定义。否则，Agent 结合燃料和氧化剂组成、已有剖面中物种随燃烧进程的变化及制表用途，根据相关参考文献提出候选。每个推荐候选都须注明支持其定义的参考文献，并说明文献依据及其对本算例的适用性。向用户说明推荐的候选定义及其依据，经用户同意后纳入本次测试。

4. **生成测试配置。** 将选定的工况、观测点和候选定义写入 `C-tabulation/00-yc_pretest/test_inputs.json`。
   - `samples` 填写制表清单中的完整 `case_name`，每个工况填写一次。
   - `z` 的 `value` 填写观测点。化学计量点可用 `is_stoichiometric: true` 在报告中标记。
   - `candidates` 中的 `name` 为报告显示名称，各候选名称须不同。`names` 填写机理中的物种名称，`weights` 按相同顺序填写对应的无量纲数值权重。

以下为配置示例。

```json
{
  "samples": [
    {"case_name": "Tf=300 K_To=1600 K_p=101325 Pa_a=300 s-1"}
  ],
  "z": [
    {"value": 0.03},
    {"value": 0.05518666598235155, "is_stoichiometric": true},
    {"value": 0.10}
  ],
  "candidates": [
    {"name": "CO₂ + H₂O", "names": ["CO2", "H2O"], "weights": [1.0, 1.0]},
    {"name": "CO₂ + H₂O + CO", "names": ["CO2", "H2O", "CO"], "weights": [1.0, 1.0, 1.0]}
  ]
}
```

### 2. 运行预实验

在当前算例根目录，使用工作台配置的 Python 调用工具。`$reactiveFile` 取自 `caseDict.mechanism.reactiveFile`。

```powershell
& $env:CHATFGM_PYTHON (Join-Path $env:CHATFGM_TOOLBOX_DIR 'tools/tabulation/test_yc_monotonicity/test_yc_monotonicity.py') `
    --test-inputs 'C-tabulation/00-yc_pretest/test_inputs.json' `
    --mechanism $reactiveFile
```

### 3. 分析预实验结果

工具运行成功后，在 ChatFGM 工作台中打开 `C-tabulation/00-yc_pretest/yc_monotonicity.html`。

结合回折步数和最大回折幅度，比较各候选在本次工况和观测 `Z` 下的表现。根据本轮结果给出推荐及主要依据。若结果不足以区分候选，说明原因，并指出补测哪些工况或观测点有助于判断。

### 4. 确认下一步

向用户提供报告路径，说明分析结论和建议，确认是选定制表采用的 `Yc` 定义，还是调整测试范围后再测。用户选定定义后，通过 `case-dict` 写入 `tabulation.progressVariableDefinition`。需要再测时，更新同一份 `test_inputs.json`，按确认后的完整范围重新运行。

## Failure Handling

发现调用失败，先告诉用户目前看到的问题、影响范围，以及接下来准备检查什么。

- **工具调用失败**。查看 `stderr`，根据报错检查调用参数、输入文件或 Python 环境。暂停受该问题影响的后续调用。

向用户说明排查结果和处理建议。需要用户补充信息或确认方案时，按工具箱 `AGENTS.md` 的规则与用户确认，再按确认的范围处理。通过 `case-dict` 更新错误记录和已确认的算例设置。

问题解决后，按已确认的完整测试配置重新运行。需要调整测试范围时，更新同一份 `test_inputs.json` 后再运行。已有报告保留到新报告成功生成时再替换。