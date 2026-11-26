---
name: flamelet-computation
description: 用于 ChatFGM 算例的一维对冲扩散火焰面计算，支持根据已有结果继续推进计算流程。涵盖着火判定与分流，以及按需开展的剖面质量检查、结果整理和后处理。
---

# Flamelet Computation

`case-dict` skill 确认 Stage B 准入条件满足后，使用本 skill 执行火焰面计算及相关工作。

## General Principles

> **求解经验**：Ember 积分报错或求解不稳定时，试着减小出错那一段的全局时间步长，往往有帮助。

### 并行配置

读取 `caseDict` 中当前求解步骤的 `parallel` 设置，沿用用户已确认的配置。模板默认启用并行，最多同时计算 2 个工况，每个工况使用 8 个求解线程。设备资源允许时可沿用模板配置。

需要调整时，结合设备可用的 CPU、内存、待算工况数和已有实测耗时，对同时计算的工况数及每个工况的求解线程数提出建议。经用户确认后，通过 `case-dict` 更新当前求解步骤的 `parallel` 设置。

关闭并行时，`--n-workers` 和 `--n-threads` 均传 `1`。

### 已有产物的核对、复用和重做

准备使用已有结果时，先查看结果文件、计算记录和用户已提供的信息，确认结果对应哪一步、哪个工况，以及当时用了什么机理和关键设置。对照当前 `caseDict` 和本次任务要求，再按该步骤的参考文档检查结果。检查通过就直接使用。

只有缺少会影响复用判断的信息时，才向用户询问具体缺哪一项。补齐并核对通过后，再使用该结果。用户提供的外部结果尚未放到对应目录时，请用户按标准算例的目录结构放好结果文件和核对所需的记录。

需要重算且已有产物时，先向用户说明要重算的工况和步骤、需要处理的旧产物，以及可能受影响的下游结果。经用户确认后，按对应步骤的参考文档处理本步骤的旧产物。参考文档无具体约定时，按确认的范围，将待重做的旧产物移出对应步骤的产物目录作为备份，或删除。下游产物按「重算后检查下游产物」核对后再处理。

### 重算后检查下游产物

用户主动要求的重算和排查问题后的重算，都要在核对本步结果后立即检查是否有后续产物或清单用过旧结果。有的话，逐项判断是否仍可用。

确认有文件不能继续使用时，先告诉用户哪些文件受影响、为什么不能再用。经用户确认后，在确认范围内将这些文件移出对应步骤的产物目录作为备份，或删除。

## Execution

### 确定执行范围

先明确用户本次想完成的工作，读取当前算例的 `0-caseDict/caseDict`，并查看已有的火焰面结果（如有）。对照 `Flamelet Workflow` ，按工况判断哪些步骤已有可用结果、哪些仍需执行。

用户指定做到某一步时，以该步为目标，将所需且尚无可用结果的前置步骤纳入执行范围。用户只要求检查剖面或查看已有结果时，按对应操作核对所需数据。用户调整目标时，重新确定执行范围。

确定拟执行的步骤后，查阅对应参考文档，核对该步所需的设置、机理和输入文件，并明确预期产出。

开始执行前，向用户简要说明本次要完成哪些步骤、涉及哪些工况，以及准备复用哪些已有结果、按什么顺序完成剩余工作。

### 执行选定步骤

按 `Flamelet Workflow` 中的依赖顺序执行本次选定的步骤。执行每个步骤前，查阅该步骤对应的参考文档，并按其中的说明核对输入、调用工具和检查结果。需要确认 Ember 的参数含义或求解器行为时，查阅 [Ember 官方文档（离线版）](references/literature/ember-doc/sphinx/html/index.html)。

执行中涉及重算时，核对本步重算结果后，立即按[重算后检查下游产物](#重算后检查下游产物)处理，再继续下一步。

## Flamelet Workflow

按工况核对以下步骤的前置结果。瞬态着火预实验按需开展。着火判定完成后，按着火清单确定各工况可进入的求解分支。

### 1. 非反应混合线

- **前置结果**为 Stage A 准备的零反应机理。
- **产出**为达到稳态的最终混合剖面 `prof000001.h5` 和求解记录。最终剖面用作同工况瞬态着火的初场。
- 执行前查阅[非反应混合线操作说明](references/nonreactive-mixing-line.md)。

### 瞬态着火预实验（选做）

- **前置结果**为代表工况的非反应混合线最终剖面和 Stage A 准备的反应机理。
- **产出**为试算剖面、剖面质量报告、采样诊断图，以及时间步长和剖面保存设置的建议。
- 执行前查阅[瞬态着火预实验操作说明](references/transient-ignition.md#预实验选做)。

### 2. 正式瞬态着火

- **前置结果**为各拟算工况的非反应混合线最终剖面和 Stage A 准备的反应机理。开展过预实验时，采用试算后确认的设置。
- **产出**为各工况的瞬态剖面序列和 `case_status.txt`，以及正式计算的 `_status.csv`。
- 执行前查阅[正式瞬态着火操作说明](references/transient-ignition.md)。

### 3. 着火判定与分流

- **前置结果**为正式计算的 `_status.csv` 和正常完成工况的 `case_status.txt`。已着火且末态判稳的工况还需有编号剖面，用于选取延拓初值。
- **产出**为着火清单 `ignition_status.csv`，记录各工况的着火状态和可交接的延拓初值路径。
- 执行前查阅[着火判定与分流操作说明](references/ignition-classification.md)。

### 4a. 稳态延拓

- **前置结果**为着火清单中 `ignited=True` 且已填写 `restart_file` 的工况、该路径指向的瞬态末态剖面，以及 Stage A 准备的反应机理。
- **产出**为各目标应变率的求解记录和剖面 `prof_eps*.h5`。按目标应变率确认并交付达到 \(Q\) 稳态判据的剖面。
- 执行前查阅[稳态延拓操作说明](references/steady-flame-continuation.md)。

### 4b. 冻结火焰面（FFM）

- **前置结果**为着火清单中 `ignited=False` 的工况，以及 Stage A 准备的配套反应机理和零反应机理。
- **产出**为燃烧稳态求解保存的末态剖面 `steady.h5`、以该剖面为初场得到的零反应松弛剖面序列，以及两段求解记录。
- 执行前查阅[冻结火焰面操作说明](references/frozen-flamelet.md)。

## Profile Quality Check

- **检查单条剖面**时，将该 `.h5` 文件路径传给 `--input`。
- **检查整个工况**时，将对应的工况目录传给 `--input`。工具检查该目录下的 `prof<数字>.h5` 和 `prof_eps<数字>.h5`。

在当前算例根目录调用工具。机理中的物种及顺序应与剖面一致，入口组成和组成基准沿用生成剖面时的设置。

```powershell
& $env:CHATFGM_PYTHON (Join-Path $env:CHATFGM_TOOLBOX_DIR 'tools/flamelet/profile_diagnostics/check_profile_quality.py') `
    --input $profileInput --mechanism $mechanismFile `
    --fuel $fuel --oxidizer $oxidizer --composition-basis $compositionBasis
```

报告 `profile_quality.json` 写入剖面所在目录。

### Element Mass Fraction Residuals

在采用 \(Le=1\) 的双流对冲火焰中，若初场满足同一双流混合关系，各元素的质量分数应随混合分数线性变化。理论依据见 [Pope（2013）第 2.1 节，第 4 页式（6）后的说明](references/literature/Pope_Hottel_PCI_12.pdf)。

质量检查工具在原始网格上用物种质量分数计算各点的实际元素质量分数，再用该点的 Bilger \(Z\) 计算两侧入口的线性混合参考值。实际值减去参考值即为元素质量分数残差。报告按元素记录绝对值最大的残差，并保留其符号和网格位置。

## Postprocessing

收集工具根据当前火焰面结果生成 `B-flamelet/05-postprocess/flamelet_manifest.json`。首次需要该清单，或已有清单未反映当前结果时，在算例根目录运行以下命令。需要覆盖已有清单时，先说明影响并取得用户确认。归档旧工况时，将目录移出收集工具扫描的结果目录。

```powershell
& $env:CHATFGM_PYTHON (Join-Path $env:CHATFGM_TOOLBOX_DIR 'tools/flamelet/postprocess/collect_flamelet_profiles.py')
```

补写 Bilger \(Z\) 时，将本次使用的清单路径赋给 `$manifest`，通过 `--manifest` 传入。`$reactiveFile` 取自 `mechanism.reactiveFile`。机理中的物种及顺序应与剖面一致，入口组成和组成基准沿用求解时的设置。工具只处理指定清单中的剖面，已有 \(Z\) 的直接复用，缺少 \(Z\) 的在原有空间点补写。

```powershell
& $env:CHATFGM_PYTHON (Join-Path $env:CHATFGM_TOOLBOX_DIR 'tools/flamelet/postprocess/write_bilger_z.py') `
    --manifest $manifest `
    --mechanism $reactiveFile --fuel $fuel --oxidizer $oxidizer `
    --composition-basis $compositionBasis
```

### 阶段内查看结果

在 ChatFGM 工作台预览 `B-flamelet/05-postprocess/flamelet_viewer.html`，通过顶部的 **Result set** 下拉框选择要看的结果。

- **Flamelet results（默认）**。使用 `flamelet_manifest.json` 查看当前火焰面结果。清单缺失或需要更新时，先运行上面的收集命令。将 `$manifest` 设为 `B-flamelet/05-postprocess/flamelet_manifest.json`，按这份清单补写 \(Z\)。
- **Tabulation samples**。使用 `tabulation_manifest.json`，只显示已筛选用于制表的工况和剖面。制表清单尚未生成时，查看器会显示提示。

### 交接 Stage C 前整理结果

1. 确认 `flamelet_manifest.json` 已反映当前结果。清单缺失或需要更新时，先运行上面的收集命令。将这份清单复制到一个临时文件。
2. 对照着火清单、求解记录和各步骤的交付标准，在临时清单中按本次制表范围筛选剖面。筛选前，向用户说明拟保留和移出的工况或剖面、移出原因，以及对制表范围的影响。
   - 已着火工况保留正常完成的正式瞬态剖面，以及达到 \(Q\) 稳态判据的延拓剖面。
   - 未着火工况保留状态为 `SUCCESS` 的 FFM 松弛剖面。

   从临时清单中移出混合线和其他不在上述范围内的剖面。筛选后没有剩余剖面的工况，也从临时清单中移出。

3. 将 `$manifest` 设为筛选后的临时清单路径，通过 `--manifest` 指定这份清单补写 \(Z\)。确认清单包含本次制表所需的可用剖面，且每条剖面的 \(Z\) 可读取并与原网格逐点对应。
4. 核对通过后，将临时清单保存为 `B-flamelet/05-postprocess/tabulation_manifest.json`，作为 Stage C 的输入。若要替换已有制表清单，先说明影响并取得用户确认，再保存。

## Completion and Handoff

本次工作结束后，按用户确认的范围核对完成情况。向用户说明完成了哪些步骤和工况、可用结果放在哪里，以及还有哪些事项未完成、原因是什么。通过 `case-dict` 更新相关算例记录。

本次任务需要准备制表样本时，按[交接 Stage C 前整理结果](#交接-stage-c-前整理结果)准备并核对制表清单，向用户提供 `B-flamelet/05-postprocess/tabulation_manifest.json` 的路径和清单覆盖的工况范围。

用户要求推进到后续阶段时，回到 `case-dict` skill，根据用户目标和已有产物确定下一阶段，并检查该阶段的准入条件。
