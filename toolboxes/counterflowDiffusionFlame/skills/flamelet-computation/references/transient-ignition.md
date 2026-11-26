# 瞬态着火

瞬态着火是火焰面求解流程的第二步，接在非反应混合线之后。预实验和正式计算均使用反应机理，以各自工况的非反应混合线最终剖面为初场。

正式计算前可选取代表工况进行预实验，通过检查剖面质量和采样情况，评估时间步长和剖面保存设置。正式计算按确定的设置对选定工况进行积分，保存随时间变化的火焰面剖面和求解记录，供下一步着火判定与分流使用。

## Inputs and Checks

- **反应机理**取自 `caseDict` 的 `mechanism.reactiveFile`。从当前算例根目录检查文件是否可读取，调用时沿用该相对路径。
- **入口组成**取自 `boundaryConditions.fuelComposition` 和 `boundaryConditions.oxidizerComposition`。两侧共用 `compositionBasis`，取 `moleFraction` 或 `massFraction`。
- **入口工况**按执行范围选取。参数扫描使用 `fuelTemperature`、`oxidizerTemperature`、`pressure` 和 `transientStrainRates` 四个列表确定工况。显式工况从 `operatingConditions` 读取选中的条目，每条包含两侧入口温度、压力和 `transientStrainRate`。
- **混合线初场**取自 `B-flamelet/01-nonreactive_mixing_line/` 下对应工况的最终剖面 `prof000001.h5`。确认剖面可用、与当前工况一致，且生成该剖面所用的零反应机理与本次反应机理配套。
- **数值设置**取自 `numericalSetup.ignition`，包括全局时间步长 `globalTimeStep`、`parallel` 中的并行设置，以及 `profileSaving` 中的启动阶段温差阈值 `startupDeltaTThreshold`、常规阶段温差阈值 `regularDeltaTThreshold` 和混合分数监测网格点数 `nZPoints`。
- **输出目录**位于当前算例的 `B-flamelet/02-transient_ignition/` 下。预实验写入 `pretest/`，正式计算写入 `formal/`。

## Execution

用户尚未明确是否开展预实验时，先说明试算可用于检查剖面质量和采样情况，再询问是否需要试算。计划批量计算较多工况时，建议先用一个代表工况试算。按用户的选择执行。

### 预实验（选做）

1. **选取代表工况。** 从拟正式计算的工况中，优先选取燃料和氧化剂入口温度各自最高、压力最高且瞬态应变率最小的组合。若这些极值分属不同工况，选取一组入口温度较高、压力较高且瞬态应变率较小的拟算工况，并说明选择依据。

2. **运行试算。** 使用当前的时间步长和剖面保存设置，从代表工况的混合线最终剖面开始计算。按本节末尾的瞬态着火命令调用工具，四个工况数组各传入该工况的一个值。`--n-workers` 传 `1`，`--n-threads` 按并行配置取值。将 `$ignitionRoot` 设为 `B-flamelet/02-transient_ignition/pretest/`。

3. **检查剖面质量。** 试算正常结束后，按[入口的剖面质量检查说明](../SKILL.md#profile-quality-check)，将本次试算的工况目录传给 `--input`，检查目录中的编号剖面。工具会在该目录下生成 `profile_quality.json`。

4. **检查剖面采样。** 在当前算例根目录调用 `plot_profile_sampling.py`。将 `$pretestCaseDir` 设为 `B-flamelet/02-transient_ignition/pretest/` 下本次试算的工况目录。

   ```powershell
   & $env:CHATFGM_PYTHON (Join-Path $env:CHATFGM_TOOLBOX_DIR 'tools/flamelet/profile_diagnostics/plot_profile_sampling.py') `
       --input $pretestCaseDir
   ```

   工具默认在试算工况目录生成 `profile_sampling_tmax.png` 和 `profile_sampling_heat_release.png`，分别显示最高温度和整体化学放热率随保存时间的变化。整体化学放热率由每帧的体积放热率 `q` 沿原始空间网格 `x` 积分得到。两张图上的点均对应实际保存的剖面。

5. **分析试算结果。** 结合剖面质量报告和两张采样图，评估当前的时间步长和剖面保存设置。

   - 阅读 `profile_quality.json`，结合温度和物种质量分数的取值、质量分数之和、\(Z\) 的单调性和取值范围，以及元素质量分数残差，判断剖面是否有明显异常。若有异常，分析可能原因及其与时间步长的关系。
   - 查看最高温度图和整体放热率图，检查保存帧在整个试算过程中的分布。有明显温升时，重点看温升 10%–90% 区间的帧数和间隔。有明显放热峰时，结合放大图检查峰值附近及放热快速上升、回落阶段的帧间隔。若采样偏稀，指出需要加密的时间区间。

6. **确认下一步。** 向用户说明试算结论和建议，结合本次任务范围，与用户确认是否继续。需要继续时，确定是沿用现有设置进行正式计算、调整后进行正式计算，还是调整后再试算。需要调整设置时，通过 `case-dict` 写入用户确认的变更。如需复试，按[已有产物的核对、复用和重做](../SKILL.md#已有产物的核对复用和重做)处理已有试算产物，再从同一混合线初场重新计算。

### 正式计算

根据用户本次要完成的工作，从 `caseDict` 的参数扫描组合或显式工况中，选出本次需要正式瞬态着火结果的工况。

按[已有产物的核对、复用和重做](../SKILL.md#已有产物的核对复用和重做)逐工况核对 `formal/` 下的计算结果。已有可用结果的工况直接复用。将目标位置尚无产物的工况及经用户确认需要重做且已处理旧产物的工况列入待算范围。

有待算工况时，按[并行配置](../SKILL.md#并行配置)确定并行设置，使用本节末尾的瞬态着火求解命令，并将 `$ignitionRoot` 设为 `B-flamelet/02-transient_ignition/formal/`。

- **批量提交**。采用参数扫描，且四个工况列表的笛卡尔积恰好等于本次待算工况时，传入四个列表，调用工具一次。
- **逐工况调用**。显式工况逐条提交。采用参数扫描时，若本次待算工况无法用四个列表的笛卡尔积恰好表示，也逐条提交。每次将燃料入口温度、氧化剂入口温度、压力和瞬态应变率分别放入四个单元素数组，`--n-workers` 传 `1`，`--n-threads` 按并行配置取值。等当前调用退出后，再提交下一工况。

### 瞬态着火求解命令

预实验和正式计算共用以下命令。在当前算例根目录，使用工作台配置的 Python 启动工具。`$mixingLineRoot` 指向 `B-flamelet/01-nonreactive_mixing_line/`。

```powershell
& $env:CHATFGM_PYTHON (Join-Path $env:CHATFGM_TOOLBOX_DIR 'tools/flamelet/transient_ignition/run_transient_ignition.py') `
    --mechanism $reactiveFile --mixing-line-root $mixingLineRoot --output $ignitionRoot `
    --fuel $fuel --oxidizer $oxidizer --composition-basis $compositionBasis `
    --fuel-temperature @fuelTemperatures --oxidizer-temperature @oxidizerTemperatures `
    --pressure-pa @pressuresPa --strain-rate @strainRates `
    --global-timestep $globalTimeStep --n-workers $nWorkers --n-threads $nThreads `
    --startup-delta-t-threshold $startupDeltaTThreshold `
    --regular-delta-t-threshold $regularDeltaTThreshold --n-z-points $nZPoints
```

## Result Verification

1. 每次调用瞬态着火工具后，检查退出码。若工具返回了 JSON 摘要，一并读取。发现调用失败时，按 `Failure Handling` 处理。
2. 按工况目录名核对 `_status.csv` 中本轮新增的记录。预实验查 `pretest/_status.csv`，正式计算查 `formal/_status.csv`。状态为 `SUCCESS` 的工况视为求解正常完成。工况状态为 `FAILED` 时，按 `Failure Handling` 处理。

**预实验交付**包括试算剖面、剖面质量报告、两张采样诊断图，以及按 `Execution` 得出的试算结论和设置建议。
**正式计算交付**按工况确认。对每个正常完成的工况，交付瞬态火焰面剖面序列和求解记录，并向用户提供结果目录。正式计算结果用于后续着火判定与分流。已着火工况的瞬态剖面经 Stage B 结果整理后，可供 Stage C 制表使用。

## Failure Handling

发现调用失败、工况求解失败时，先告诉用户目前看到的问题、影响哪些工况，以及接下来准备检查什么。

- **工具调用失败**。查看 `stderr`，并结合工具已返回的摘要或报告，根据报错检查调用参数、输入文件或 Python 环境。暂停受该问题影响的后续调用。
- **工况求解失败**。查看 `_status.csv` 中该工况本轮的 `message`。如果已有 `solver.log`，结合日志排查。其他独立工况可按已确认的范围继续。

向用户说明排查结果和处理建议。需要用户补充信息或确认方案时，按工具箱 `AGENTS.md` 的规则与用户确认，再按确认的范围处理。通过 `case-dict` 更新错误记录和已确认的算例设置。

问题解决后，按需重试受影响的工具调用。需要重算时，只提交仍需计算的工况。重算前如需处理本步骤的旧产物，按[已有产物的核对、复用和重做](../SKILL.md#已有产物的核对复用和重做)处理。核对重算结果后，立即按[重算后检查下游产物](../SKILL.md#重算后检查下游产物)检查受影响的后续产物。

## Method Notes

### Integration Time Limit

柴油喷雾着火需要经历蒸发、混合和化学诱导。在这段时间里，活塞继续运动，缸内温度和压力随压缩和膨胀而变化。瞬态火焰面计算采用固定的入口条件、压力和应变率，因此用发动机过程的时间尺度来限定观察窗口，判断给定工况能否在这段时间内着火。

工具箱取 800 r/min 作为低转速参考，取 120° 曲轴转角作为较宽的观察范围。120° 相当于四冲程发动机一个冲程的三分之二。同样的曲轴转角在低转速下对应更长的时间，可以给着火延迟较长的工况留出观察余量。对应的积分时限为

\[
t_{\max}=\frac{60}{800}\times\frac{120}{360}=0.025\ \mathrm{s}=25\ \mathrm{ms}.
\]

工况正常积分至 25 ms 且始终未触发着火温度阈值时，归为本次积分时限内未着火。

### Online Ignition Estimate

程序使用反应机理，对非反应混合线初场的各空间点分别计算恒焓、恒压平衡温度，并取其中的最大值作为 \(T_{\mathrm{ad}}\)。氧化剂入口温度 \(T_{\mathrm{ox}}\) 用作反应前的温度参考，\(T_{\mathrm{ad}}-T_{\mathrm{ox}}\) 给出该工况的参考温升。取参考温升的一半作为在线着火阈值所需的温升。

\[
T_{\mathrm{ign}}=T_{\mathrm{ox}}+\frac{T_{\mathrm{ad}}-T_{\mathrm{ox}}}{2}.
\]

当剖面最高温度 \(T_{\max}\) 首次达到或超过 \(T_{\mathrm{ign}}\) 时，程序记录该时刻为着火时间。这里的 50% 是经验比例，用于标记明显的高温反应。初场最高温度接近阈值时，触发时刻容易受到初场温度影响。低温放热或强应变下的弱反应也可能发生在阈值以下。

程序从积分开始就记录放热率，触发着火温度阈值后才启用放热率稳态判据。着火前，放热率可能长时间接近零且变化很小，足以满足稳态判据的绝对容差。先检查温度阈值，可以避免在着火诱导期因放热率波动很小而提前终止积分。

### Steady-State Criterion

以体积放热率沿空间方向的积分 \(Q\) 衡量火焰整体放热是否稳定。程序每隔 10 个全局时间步设一个检查点。着火温度阈值触发后，使用覆盖最近 2 ms 的 \(Q\) 历史数据，计算平均值 \(\bar Q\) 和各采样值相对平均值的均方根偏差 \(\sigma_Q\)。

相对偏差 \(\sigma_Q/|\bar Q|\) 小于 1%，或绝对偏差 \(\sigma_Q\) 小于 \(0.5\ \mathrm{W/m^2}\) 时，判定整体放热已稳定，结束积分。历史数据不足或偏差仍高于容差时，继续积分至满足判据或达到 25 ms 时限。

### Profile Sampling

程序把不同时刻的温度剖面插值到同一套 Bilger \(Z\) 监测网格上，在相同的混合分数位置逐点比较温度，并以最大绝对温差作为保存依据。监测网格在 \([0,1]\) 上均匀分布，点数由 `nZPoints` 指定，默认值为 `201`。

- **启动阶段。** 相对于上一张实际保存的剖面，最大温差达到 `startupDeltaTThreshold` 时保存当前剖面。默认阈值为 `1 K`。
- **转入常规阶段。** 相对于初始剖面，最大温差首次达到 `regularDeltaTThreshold` 时保存当前剖面，从下一时间步进入常规阶段。默认阈值为 `10 K`。
- **常规阶段。** 相对于上一张实际保存的剖面，最大温差达到 `regularDeltaTThreshold` 时保存当前剖面。

初始剖面和正常结束时的最终剖面均保存。较小的温差阈值会使剖面保存更密集。可通过预实验的最高温度图和整体放热率图，检查快速温升和放热快速变化时段的剖面保存是否足够密集。
