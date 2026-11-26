# 稳态延拓

稳态延拓接在着火判定与分流之后，以已着火工况的瞬态末态为起点，计算不同应变率下的稳态火焰面。各目标应变率的最终剖面和求解记录按工况保存，稳态火焰面剖面供后续制表使用。

## Inputs and Checks

- **着火清单**位于当前算例的 `B-flamelet/ignition_status.csv`。确认清单可读取。
- **反应机理**取自 `caseDict` 的 `mechanism.reactiveFile`。从当前算例根目录检查文件是否可读取，调用时沿用该相对路径。
- **入口组成**取自 `boundaryConditions.fuelComposition` 和 `boundaryConditions.oxidizerComposition`。两侧共用 `compositionBasis`，取 `moleFraction` 或 `massFraction`。
- **目标应变率序列**取自 `boundaryConditions.continuationStrainRates`。确认各目标均为整数，并按已确认的延拓顺序填写。
- **数值设置**取自 `numericalSetup.continuation`，包括全局时间步长 `globalTimeStep` 和 `parallel` 中的并行设置。
- **输出目录**为当前算例下的 `B-flamelet/03-steady_flame_continuation/`。

## Execution

根据用户本次要完成的工作，从着火清单中选出本次范围内 `ignited=True` 且已填写 `restart_file` 的工况。

对每个选中的工况，从 `continuationStrainRates` 中保留小于或等于该工况初始应变率的目标，沿用列表中的原顺序。没有符合条件的目标时，跳过该工况。

按[已有产物的核对、复用和重做](../SKILL.md#已有产物的核对复用和重做)逐工况核对本次所需的延拓结果。所需目标均已有可用结果时，直接复用。缺少可用结果的工况列入待算范围。工具对每个提交的工况从 `restart_file` 开始，按本次传入的适用目标顺序求解。需要重算已有结果时，先按上述规则处理相关产物，再提交该工况。

有待算工况时，按[并行配置](../SKILL.md#并行配置)确定并行设置，并按以下方式提交。

- **提交全部工况**。待算工况恰好是着火清单中 `ignited=True` 且已填写 `restart_file` 的全部工况时，直接使用下方命令。
- **提交部分工况**。只需计算其中一部分时，为每个待算工况追加一次 `--case`，传入着火清单中的完整 `case_name`。例如，提交两个工况时，在命令末尾追加 `--case $caseName1 --case $caseName2`。

在当前算例根目录，使用工作台配置的 Python 调用稳态延拓工具。

```powershell
& $env:CHATFGM_PYTHON (Join-Path $env:CHATFGM_TOOLBOX_DIR 'tools/flamelet/steady_flame_continuation/run_steady_flame_continuation.py') `
    --mechanism $reactiveFile `
    --fuel $fuel --oxidizer $oxidizer --composition-basis $compositionBasis `
    --strain-rate @continuationStrainRates --global-timestep $globalTimeStep `
    --n-workers $nWorkers --n-threads $nThreads
```

## Result Verification

1. 每次工具调用结束后，检查退出码。若返回了 JSON 摘要，一并读取。发现调用失败时，按 `Failure Handling` 处理。
2. 按工况目录名核对输出目录下 `_status.csv` 中本轮新增的记录。`FAILED` 工况按 `Failure Handling` 处理。`SKIP` 表示该工况没有小于或等于初始应变率的目标，向用户说明跳过原因。
3. 对已生成剖面的各目标应变率，查看对应的 `log-eps*.txt`，确认求解是否达到 \(Q\) 稳态判据。尚未确认达到稳态的目标，按 `Failure Handling` 处理。

**预期交付**按工况和目标应变率确认。向用户汇报达到稳态的目标及对应的 `prof_eps*.h5` 路径。这些剖面供后续火焰面结果整理和制表使用。

## Failure Handling

发现调用失败、工况求解失败或结果核对未通过时，先告诉用户目前看到的问题、影响哪些工况，以及接下来准备检查什么。

- **调用失败且未返回摘要**。查看 `stderr`，根据报错检查命令参数、机理路径或 Python 环境。暂停受该问题影响的后续调用。
- **工况求解失败**。查看 `_status.csv` 中该工况本轮的 `message`。若已生成 `log-eps*.txt`，结合日志定位失败的目标应变率和原因。其他独立工况可按已确认的范围继续。
- **目标应变率未确认达到稳态**。查看该目标对应的 `log-eps*.txt`，向用户说明受影响的工况、目标应变率和能确认的终止原因。证据不足时，将该目标汇报为尚未确认达到稳态。

向用户说明排查结果和处理建议。需要用户补充信息或确认方案时，按工具箱 `AGENTS.md` 的规则与用户确认，再按确认的范围处理。通过 `case-dict` 更新错误记录和已确认的算例设置。

问题解决后，按需重试受影响的工具调用。需要重算时，只提交仍需计算的工况。重算前如需处理本步骤的旧产物，按[已有产物的核对、复用和重做](../SKILL.md#已有产物的核对复用和重做)处理。核对重算结果后，立即按[重算后检查下游产物](../SKILL.md#重算后检查下游产物)检查受影响的后续产物。

## Method Notes

在同一燃烧分支上，应变率相近时，稳态火焰的温度、组分和流动剖面通常也相近。以前一个应变率下的稳态剖面作为初场，可以让已有的火焰在新的拉伸条件下重新调整，从而沿同一燃烧分支逐点追踪稳态解。

Ember 的 `multirun` 按给定的应变率序列依次求解。第一个目标以瞬态着火计算的末帧为初场。每个目标在固定应变率下积分，结束后保存该点的最终剖面，并将其作为下一个目标的初场。
