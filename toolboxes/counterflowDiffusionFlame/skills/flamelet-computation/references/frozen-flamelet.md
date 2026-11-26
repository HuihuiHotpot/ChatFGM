# 冻结火焰面（FFM）

冻结火焰面接在着火判定与分流之后，从着火清单中选取正式瞬态正常完成、但在积分时限内未着火的工况。为给零反应松弛建立燃烧初场，先用反应机理在同一工况下求取燃烧稳态，再以该稳态剖面为初场切换到零反应机理，计算温度和组分向非反应混合状态的松弛过程。

两段结果按工况保存。燃烧稳态剖面用作松弛初场，核对通过的松弛剖面序列经火焰面结果整理后供 Stage C 制表使用。

## Inputs and Checks

- **着火清单**位于当前算例的 `B-flamelet/ignition_status.csv`。确认清单可读取。
- **机理文件**取自 `caseDict` 的 `mechanism.reactiveFile` 和 `mechanism.nonReactiveFile`，分别用于燃烧稳态求解和零反应松弛。确认两份文件是 Stage A 准备的配套机理，且均可从当前算例根目录按预设路径读取。
- **入口组成**取自 `boundaryConditions.fuelComposition` 和 `boundaryConditions.oxidizerComposition`。两侧共用 `compositionBasis`，取 `moleFraction` 或 `massFraction`。
- **时间步长**取自 `numericalSetup.ffm`。燃烧稳态求解使用 `initialGlobalTimeStep`，零反应松弛使用 `globalTimeStep`。
- **松弛段采样设置**取自 `numericalSetup.ffm.profileSaving`。`deltaTmaxThreshold` 和 `rmsDeltaTThreshold` 分别是相对于上一保存剖面的最高温度差阈值和固定 \(Z\) 网格上的温差均方根阈值。`nZPoints` 指定该监测网格的点数。
- **并行设置**取自 `numericalSetup.ffm.parallel`。
- **输出目录**为当前算例下的 `B-flamelet/04-frozen_flamelet/`。燃烧稳态和松弛结果分别写入 `burning_steady/` 和 `ffm/`。

## Execution

根据用户本次要完成的工作，从着火清单中选出本次范围内 `ignited=False` 的工况。

按[已有产物的核对、复用和重做](../SKILL.md#已有产物的核对复用和重做)，逐工况核对 `burning_steady/<工况>/steady.h5` 和 `ffm/<工况>/` 下的松弛剖面。两段结果均可用时直接复用。缺少任一段可用结果的工况列入待算范围。重算时工具从燃烧稳态段开始，有旧产物的先按上述规则处理，再提交该工况。

有待算工况时，按[并行配置](../SKILL.md#并行配置)确定并行设置，并按以下方式提交。

- **提交全部未着火工况**。待算工况恰好是着火清单中 `ignited=False` 的全部工况时，省略 `--case`。
- **提交部分未着火工况**。只需计算其中一部分时，为每个待算工况追加一次 `--case`，传入着火清单中的完整 `case_name`。例如，提交两个工况时，在命令末尾追加 `--case $caseName1 --case $caseName2`。

在当前算例根目录，使用工作台配置的 Python 调用冻结火焰面工具。

```powershell
& $env:CHATFGM_PYTHON (Join-Path $env:CHATFGM_TOOLBOX_DIR 'tools/flamelet/frozen_flamelet/run_ffm.py') `
    --mechanism $reactiveFile --nonreactive-mechanism $nonReactiveFile `
    --fuel $fuel --oxidizer $oxidizer --composition-basis $compositionBasis `
    --initial-global-timestep $initialGlobalTimeStep --global-timestep $globalTimeStep `
    --delta-tmax-threshold $deltaTmaxThreshold --rms-delta-t-threshold $rmsDeltaTThreshold `
    --n-z-points $nZPoints --n-workers $nWorkers --n-threads $nThreads
```

一次工具调用中，工具对每个提交的工况依次执行以下两段求解。

1. **求取燃烧稳态。** 使用反应机理，从 Ember 构造的高温初场开始，按该工况的入口条件和应变率积分。使用 `initialGlobalTimeStep`，将末态保存为 `burning_steady/<工况>/steady.h5`。
2. **计算零反应松弛。** 第一段正常返回后，读取同一工况的 `steady.h5` 作为初场，切换到零反应机理，沿用该工况的入口条件和应变率。使用 `globalTimeStep` 和松弛段采样设置，将编号剖面写入 `ffm/<工况>/`。

## Result Verification

1. 每次工具调用结束后，检查退出码。若返回了 JSON 摘要，一并读取。发现调用失败时，按 `Failure Handling` 处理。
2. 按工况目录名核对 `B-flamelet/04-frozen_flamelet/_status.csv` 中本轮新增的记录。`SUCCESS` 表示该工况的两段求解均正常返回。`FAILED` 工况按 `Failure Handling` 处理。

**预期交付**按工况确认。对状态为 `SUCCESS` 的工况，交付 `ffm/<工况>/` 下的编号剖面序列，包括松弛首帧、采样保存的中间帧和末帧。向用户提供松弛结果目录和对应的 `steady.h5` 路径。松弛剖面序列经火焰面结果整理后供 Stage C 制表使用。

## Failure Handling

发现调用失败或工况求解失败时，先告诉用户目前看到的问题、影响哪些工况，以及接下来准备检查什么。

- **调用失败且未返回摘要**。查看 `stderr`，根据报错检查命令参数、输入文件或 Python 环境。暂停受该问题影响的后续调用。
- **工况求解失败**。查看 `_status.csv` 中该工况本轮的 `message`，确定出错环节。若对应的 `burning_steady/<工况>/solver.log` 或 `ffm/<工况>/solver.log` 已生成，结合日志排查。其他独立工况可按已确认的范围继续。

向用户说明排查结果和处理建议。需要用户补充信息或确认方案时，按工具箱 `AGENTS.md` 的规则与用户确认，再按确认的范围处理。通过 `case-dict` 更新错误记录和已确认的算例设置。

问题解决后，按需重试受影响的工具调用。需要重算时，只提交仍需计算的工况。重算前如需处理本步骤的旧产物，按[已有产物的核对、复用和重做](../SKILL.md#已有产物的核对复用和重做)处理。核对重算结果后，立即按[重算后检查下游产物](../SKILL.md#重算后检查下游产物)检查受影响的后续产物。

## Method Notes

柴油机进入膨胀行程后，缸内平均温度下降。缸内仍有燃烧产物，近壁区和活塞缝隙内还可能残留温度更低的未燃燃料。此时化学反应活性很弱，FGM 表仍需覆盖低未燃温度下从非反应混合到完全燃烧的温度和组分状态。常规对冲火焰面在这些低温条件下可能无法自燃，或需要很长时间才能着火并达到热平衡。FFM 用于补充这部分制表样本。

Maghbouli 等针对每个压力区间，先确定对冲火焰面能够自燃并达到充分燃烧的最低未燃温度。随后以该温度下充分燃烧的剖面为初场，将氧化剂入口温度设为目标低温，保留化学反应并积分至新的燃烧稳态。图 12 以氧化剂入口温度从 850 K 降至 500 K 为例。

本工具箱直接在目标工况下用 Ember 求解。Ember 在初始剖面的中心区设置高温平衡产物，再采用反应机理，在目标工况的入口条件和应变率下积分，并用 \(Q\) 判据判断是否达到稳态。第一段正常返回后，工具以保存的末态剖面为初场，保持入口条件和应变率，切换到零反应机理。关闭化学反应后，温度和组分随输运和混合向非反应混合线松弛。沿途保存的剖面用于补充燃烧稳态与非反应混合线之间的制表样本。

方法来源见 [Maghbouli 等（2019）第 4.2.4 节及图 12](literature/Maghbouli-et-al-2019-FFM.pdf)。图 12 位于论文第 430 页，对应 PDF 文件第 18 页。图中的蓝线表示零反应松弛过程中保存的温度剖面。


