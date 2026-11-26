# 非反应混合线

非反应混合线是火焰面求解流程的第一步。对选定工况，使用零反应机理求解燃料与氧化剂在一维对冲流动中的稳态混合剖面。达到稳态判据后保存的最终剖面可作为同工况瞬态着火预实验和正式瞬态着火计算的初场。

## Inputs and Checks

- **零反应机理**取自 `caseDict` 的 `mechanism.nonReactiveFile`。从当前算例根目录检查文件是否可读取，调用时沿用该相对路径。
- **入口组成**取自 `boundaryConditions.fuelComposition` 和 `boundaryConditions.oxidizerComposition`。两侧共用 `compositionBasis`，取 `moleFraction` 或 `massFraction`。
- **入口工况**按本次执行范围选取。参数扫描使用 `fuelTemperature`、`oxidizerTemperature`、`pressure` 和 `transientStrainRates` 四个列表确定工况。显式工况从 `operatingConditions` 读取选中的条目，每条包含两侧入口温度、压力和 `transientStrainRate`。
- **数值设置**取自 `numericalSetup.mixingLine`，包括全局时间步长 `globalTimeStep` 和 `parallel` 中的并行设置。
- **输出目录**为当前算例下的 `B-flamelet/01-nonreactive_mixing_line/`。

## Execution

根据用户本次要完成的工作，从 `caseDict` 的参数扫描组合或显式工况中，选出本次需要混合线的工况。

按[已有产物的核对、复用和重做](../SKILL.md#已有产物的核对复用和重做)逐工况核对目标位置的混合线结果。已有可用结果的工况直接复用。目标位置尚无产物的工况，以及经用户确认需要重做且已处理旧产物的工况，列入本次待算范围。若所有所需工况均可复用，直接使用已有结果。

有待算工况时，按[并行配置](../SKILL.md#并行配置)确定并行设置，并选择以下提交方式。

- **批量提交**。采用参数扫描，且四个工况列表的笛卡尔积恰好等于本次待算工况时，传入四个列表，调用工具一次。
- **逐工况调用**。显式工况逐条提交。采用参数扫描时，若本次待算工况无法用四个列表的笛卡尔积恰好表示，也逐条提交。每次将燃料入口温度、氧化剂入口温度、压力和瞬态应变率分别放入四个单元素数组，`--n-workers` 传 `1`，`--n-threads` 按并行配置取值。等当前调用退出后，再提交下一工况。

在当前算例根目录，使用工作台配置的 Python 启动混合线求解工具。

```powershell
& $env:CHATFGM_PYTHON (Join-Path $env:CHATFGM_TOOLBOX_DIR 'tools/flamelet/nonreactive_mixing_line/run_mixing_line.py') `
    --mechanism $nonReactiveFile --output $mixingLineRoot `
    --fuel $fuel --oxidizer $oxidizer --composition-basis $compositionBasis `
    --fuel-temperature @fuelTemperatures --oxidizer-temperature @oxidizerTemperatures `
    --pressure-pa @pressuresPa --strain-rate @strainRates `
    --global-timestep $globalTimeStep --n-workers $nWorkers --n-threads $nThreads
```

## Result Verification

1. 每次工具调用结束后，检查退出码。若工具返回了 JSON 摘要，一并读取。发现调用失败或有工况求解失败时，按 `Failure Handling` 处理。
2. 本轮所有调用结束后，按工况目录名核对输出目录下 `_status.csv` 中本轮新增的记录，确认各工况的执行结果。
3. 对状态为 `SUCCESS` 的工况，查看对应目录下的 `solver.log`。日志应包含 `Terminating integration: dTdt variation less than specified threshold.`，表明求解因达到稳态判据而终止。若日志显示未达到稳态，或无法从日志确认是否达到稳态，按 `Failure Handling` 处理。

日志确认达到稳态判据后，将该工况列入可交付结果。

**预期交付**按工况确认。向用户汇报已达到稳态的工况，并给出各自的 `prof000001.h5` 路径。这些剖面可用于同工况的瞬态着火预实验和正式瞬态着火计算。求解失败或尚未确认达到稳态的工况，另行说明原因，按 `Failure Handling` 处理。

## Failure Handling

发现调用失败、工况求解失败或结果核对未通过时，先告诉用户目前看到的问题、影响哪些工况，以及接下来准备检查什么。

- **调用失败且未返回摘要**。查看 `stderr`，根据报错检查命令参数、机理路径或 Python 环境。暂停受该问题影响的后续调用。
- **工况求解失败**。查看 `_status.csv` 中该工况本轮的 `message`。如果已有 `solver.log`，结合日志排查。其他独立工况可按已确认的范围继续。
- **未确认达到稳态**。查看 `solver.log` 中的终止记录。能确认终止原因时，向用户说明实际原因。证据不足时，说明目前无法确认该工况已达到稳态。

向用户说明排查结果和处理建议。需要用户补充信息或确认方案时，按工具箱 `AGENTS.md` 的规则与用户确认，再按确认的范围处理。通过 `case-dict` 更新错误记录和已确认的算例设置。

问题解决后，按需重试受影响的工具调用。需要重算时，只提交仍需计算的工况。重算前如需处理本步骤的旧产物，按[已有产物的核对、复用和重做](../SKILL.md#已有产物的核对复用和重做)处理。核对重算结果后，立即按[重算后检查下游产物](../SKILL.md#重算后检查下游产物)检查受影响的后续产物。

## Method Notes

### Steady-State Criterion

非反应混合线从构造的初始剖面出发，温度和组分会在对流和扩散作用下逐步调整。以应变率 \(a\) 的倒数 \(1/a\) 作为流动特征时间，通常先积分约五个特征时间再开始判稳，给初场留出调整时间。应变率较低时，相应的等待时间更长。

判稳时，将当前温度变化率折算为一个特征时间内的相对温度变化。各网格点上这一估计值的均方根低于 \(10^{-4}\)（0.01%）时，判定温度场达到数值稳态。这样，不同应变率下可以使用同一个无量纲容差。两侧入口温度相近时，温度场可能已基本稳定，组分剖面仍在调整。
