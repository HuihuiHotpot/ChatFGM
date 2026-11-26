---
name: mechanism
description: 核对 ChatFGM 算例的原始机理，生成并核验反应机理和零反应机理两份 Cantera YAML 文件。支持两种输入，一种是 CHEMKIN 的主机理、热力学和输运三个文件，另一种是包含反应、热力学和输运数据的 Cantera YAML 文件。
---

# Mechanism Preparation

`case-dict` 确认机理准备的准入条件满足后，按用户确认的范围执行以下步骤。

## Inputs and Outputs

### Inputs

- 当前算例的 `caseDict`，提供已确认的燃料侧和氧化剂侧物种名称，以及原始机理所在目录 `mechanism.sourceDirectory`。
- `mechanism.sourceDirectory` 下的原始机理文件。

### Outputs

完整执行机理准备后，交付两份核验通过的 Cantera YAML 文件。

- 反应机理保存到 `mechanism.reactiveFile`。
- 零反应机理保存到 `mechanism.nonReactiveFile`。

两份文件沿用 `caseDict` 中预设的路径，路径相对于算例根目录。

## Standard Workflow

按用户确认的范围执行相应步骤。实际开始机理准备时，通过 `case-dict` 更新 `workflowState`。在算例根目录使用工作台配置的 Python 调用工具。先检查退出码。成功时，从标准输出的 JSON 中读取 `output_file`、`species_count` 和 `reaction_count`。失败时，根据标准错误判断原因。

### 1. 核对原始机理中的物种

从 `mechanism.sourceDirectory` 选定本次使用的原始机理，并识别输入格式。目录里有多套候选机理且无法确定用哪一套时，请用户确认。

从 `caseDict` 读取已确认的燃料侧和氧化剂侧物种名称。CHEMKIN 输入从主机理的 `SPECIES` 段核对。Cantera YAML 输入核对所用气相包含的物种。物种名称有歧义时，请用户确认。确认原始机理缺少所需物种时，列出缺少的物种及其所属侧，停止机理准备，请用户更换机理。

### 2. 检查机理数据是否齐备

- **CHEMKIN 输入**需要主机理、热力学和输运三个文件。确认主机理包含反应数据，并检查热力学和输运数据是否覆盖主机理中列出的物种。
- **Cantera YAML 输入**使用一份能够独立加载的单气相反应机理。检查该文件是否包含所需的反应、热力学和输运数据。

缺少文件或数据时，说明具体缺项，请用户补齐后再检查。确认无法补齐时，停止机理准备，请用户更换机理。

### 3. 准备待核验的 YAML

#### CHEMKIN 输入

用已选定的三份文件调用 [chemkin_to_yaml.py](../../tools/mechanism/chemkin_to_yaml.py)，将转换结果写入 `mechanism.reactiveFile`。命令中的路径变量分别指向已选定的源文件和预设的反应机理路径。

```powershell
& $env:CHATFGM_PYTHON (Join-Path $env:CHATFGM_TOOLBOX_DIR 'tools/mechanism/chemkin_to_yaml.py') `
    --input $chemkinFile --thermo $thermoFile --transport $transportFile --output $reactiveFile
```

#### Cantera YAML 输入

使用用户提供的原始 YAML 进入下一步核验。

### 4. 加载并核验反应机理

用 Cantera 加载待核验的 YAML，确认能正常加载、反应数大于零、两侧所需物种齐全，且热力学和输运数据可用。

用户提供的 YAML 通过核验后，原样复制到 `mechanism.reactiveFile`。原文件已位于该路径时，直接使用。反应机理通过核验后，进入下一步。

### 5. 生成零反应机理

以通过核验的 `mechanism.reactiveFile` 为输入，调用 [make_nonreactive.py](../../tools/mechanism/make_nonreactive.py)，将结果写入 `mechanism.nonReactiveFile`。生成成功后，按 `Validation and Handoff` 核验两份产物。

```powershell
& $env:CHATFGM_PYTHON (Join-Path $env:CHATFGM_TOOLBOX_DIR 'tools/mechanism/make_nonreactive.py') `
    --input $reactiveFile --output $nonReactiveFile
```

转换、加载、生成或核验失败时，停在失败处，说明报错和已确认的原因，并通过 `case-dict` 更新相关记录。路径、编码或运行环境问题解决后，从失败的步骤重试。确认原始机理存在无法解决的数据问题时，请用户更换机理。更换原始机理或配套文件后，从第 1 步重新核对。

## Validation and Handoff

生成后，用 Cantera 从 `mechanism.reactiveFile` 和 `mechanism.nonReactiveFile` 重新加载两份文件，并核验以下内容。

- 检查两份文件是否都能加载，反应机理的反应数是否大于零，零反应机理的反应数是否为零。
- 检查两份机理的物种名称和顺序是否一致，是否都包含燃料侧和氧化剂侧所需的物种。
- 检查两份机理的热力学和输运模型是否相同，各物种的对应数据是否一致。比较数值时，允许 YAML 读写引入的舍入误差。

任一检查未通过时，说明涉及的文件、未通过的检查项和具体问题，再按 `Standard Workflow` 末尾的失败处理规则执行。

全部检查通过后，通过 `case-dict` 将实际采用的原始机理文件路径、两份机理产物的路径和核验结论记入 `intent.decisionLog`。向用户汇报两份机理的文件路径、物种数、反应数和核验结论。

用户要求继续时，回到 `case-dict` skill，根据用户目标和已有产物确定下一阶段，并检查该阶段的准入条件。
