# 生成 Z–C 表

以 [01 准备制表样本](prepare-samples.md) 生成的 HDF5 为输入，按工况依次执行 [02 沿 Z 插值](#02-沿-z-插值)、[03 计算 Yc 上下界](#03-计算-yc-上下界)、[04 Yc 归一化为 C](#04-yc-归一化为-c) 和 [05 沿 C 插值](#05-沿-c-插值)。每个工况交付 `03` 的 `Yc` 上下界和 `05` 的 `Z–C` 表。

## 02 沿 Z 插值

将各工况的每条样本插值到同一套目标 `Z` 网格。

### Inputs

- **制表样本**。使用本次选定工况在 `C-tabulation/01-prepared_samples/<case_name>/` 中的 HDF5 样本。
- **目标 Z 网格设置**。从 `caseDict.tabulation.grid.Z` 读取网格点数 `nPoints` 和分布方式 `description`。

### Execution

按 `caseDict.tabulation.grid.Z` 的 `description` 生成目标坐标数组 `$zGrid`。数组点数与 `nPoints` 一致，包含两个端点 `0` 和 `1`，并按从 `0` 到 `1` 的顺序严格递增。若分布说明不足以确定坐标，通过 `case-dict` 补充设置后再生成网格。

在当前算例根目录，使用 ChatFGM 工作台配置的 Python 调用工具。`$caseName` 使用 `01` 中的完整工况目录名。以处理一个工况为例。

```powershell
& $env:CHATFGM_PYTHON (Join-Path $env:CHATFGM_TOOLBOX_DIR 'tools/tabulation/interpolate_z/interpolate_z.py') `
    --case $caseName `
    --z-grid @zGrid
```

处理多个选定工况时，每个工况传一次 `--case`。处理 `01` 中全部已有样本的工况时，可省略该参数。

### Result Verification

1. 检查工具退出码。运行成功后，在 `C-tabulation/02-z_interpolated/<case_name>/` 核对各工况，确认 `01` 中的每份 HDF5 样本都有同名的插值结果。
2. 核对各样本的 `Z` 坐标与本次目标网格一致。抽查逐点字段，确认其最后一维的长度等于 `Z` 网格点数，并核对字段单位和 `source_profile` 与对应的 `01` 样本一致。

**预期交付**为各工况插值到目标 `Z` 网格的 HDF5 样本，供 `03` 计算 `Yc` 上下界和 `04` 将 `Yc` 归一化为 `C` 使用。

## 03 计算 Yc 上下界

对每个工况，在各目标 `Z` 点取全部制表样本的 `Yc` 最小值和最大值。

### Inputs

- **沿 Z 插值后的样本**。使用本次选定工况在 `C-tabulation/02-z_interpolated/<case_name>/` 中核对通过的全部 HDF5 样本。

### Execution

在当前算例根目录，使用 ChatFGM 工作台配置的 Python 调用工具。`$caseName` 使用 `02` 中的完整工况目录名。以处理一个工况为例。

```powershell
& $env:CHATFGM_PYTHON (Join-Path $env:CHATFGM_TOOLBOX_DIR 'tools/tabulation/compute_yc_bounds/compute_yc_bounds.py') `
    --case $caseName
```

处理多个选定工况时，每个工况传一次 `--case`。处理 `02` 中全部已有插值样本的工况时，可省略该参数。

### Result Verification

1. 检查工具退出码。运行成功后，确认各工况的 `C-tabulation/03-yc_bounds/<case_name>/yc_bounds.h5` 可读取，包含 `Z`、`Yc_min` 和 `Yc_max`。
2. 核对 `Z` 与对应工况的 `02` 样本网格一致，上下界数组的长度与网格点数一致。抽查目标 `Z` 点，确认上下界分别是同工况样本在该点的 `Yc` 最小值和最大值。

**预期交付**为各工况的 `yc_bounds.h5`，供 `04` 将 `Yc` 归一化为 `C` 使用。

## 04 Yc 归一化为 C

用 `03` 得到的 `Yc` 上下界，对 `02` 中的每条样本计算归一化进度变量 `C`。

### Inputs

- **沿 Z 插值后的样本**。使用本次选定工况在 `C-tabulation/02-z_interpolated/<case_name>/` 中的 HDF5 样本。
- **Yc 上下界**。使用同一工况的 `C-tabulation/03-yc_bounds/<case_name>/yc_bounds.h5`。上下界须由本次使用的同一批 `02` 样本计算得到，并使用同一套 `Z` 网格。

### Method Notes

归一化只在 `0 < Z < 1` 的内部网格点进行。对同一工况，在每个内部 `Z` 点使用该点的 `Yc` 上下界计算 `C`。

\[
C = \frac{Y_c - Y_{c,\min}}{Y_{c,\max} - Y_{c,\min}}
\]

在对冲扩散火焰中，`Z` 表示燃料与氧化剂两股来流的混合比例。在两股来流混合的内部区域，同一 `Z` 下可以有不同燃烧进程对应的热化学状态，`C` 用来区分这些状态。`Z=0` 和 `Z=1` 分别对应氧化剂来流和燃料来流。在固定工况下，两端的热化学状态由各自的入口组分、温度和工况压力确定。

因此，在同一侧入口，各条剖面的 `Yc` 都等于该来流的 `Yc`，上下界理论上重合，归一化的 `C` 无法定义。`04` 在两端用 `C=0` 占位。规则表仍在两端为各目标 `C` 保留网格位置，这些位置都对应同一个入口状态。`05` 取首条剖面的入口值填入这些位置。

### Execution

在当前算例根目录，使用 ChatFGM 工作台配置的 Python 调用工具。`$caseName` 使用 `02` 中的完整工况目录名。以处理一个工况为例。

```powershell
& $env:CHATFGM_PYTHON (Join-Path $env:CHATFGM_TOOLBOX_DIR 'tools/tabulation/normalize_c/normalize_c.py') `
    --case $caseName
```

处理多个选定工况时，每个工况传一次 `--case`。处理 `02` 中全部已有插值样本的工况时，可省略该参数。

### Result Verification

1. 检查工具退出码。运行成功后，在 `C-tabulation/04-c_normalized/<case_name>/` 核对样本，确认 `02` 中的每份 HDF5 都有同名结果。
2. 核对新增的 `C` 字段与 `Z` 网格等长，两侧入口值为 `0`。抽查内部 `Z` 点，确认同一工况各样本的 `C` 值在 `0` 到 `1` 之间，且最小值为 `0`、最大值为 `1`。

**预期交付**为各工况新增了 `C` 字段的 HDF5 样本，供 `05` 沿 `C` 插值使用。

## 05 沿 C 插值

在每个固定 `Z` 点，沿同一工况的剖面序列插值到目标 `C` 网格，生成该工况的 `Z–C` 表。

### Inputs

- **归一化后的样本**。使用本次选定工况在 `C-tabulation/04-c_normalized/<case_name>/` 中核对通过的全部 HDF5 样本。
- **目标 C 网格设置**。从 `caseDict.tabulation.grid.C` 读取网格点数 `nPoints` 和分布方式 `description`。

### Method Notes

已着火工况先按帧号排列瞬态剖面，再接按目标应变率降序排列的稳态延拓剖面。FFM 独立按帧号排列。剖面顺序与 `00` 单调性预实验一致。

`Z=0` 和 `Z=1` 按 [04 Yc 归一化为 C](#04-yc-归一化为-c) 中的入口规则处理，分别将排序后首条剖面的两侧入口值用于所有目标 `C`。

### Execution

按 `caseDict.tabulation.grid.C` 的 `description` 生成目标坐标数组 `$cGrid`。数组点数与 `nPoints` 一致，包含两个端点 `0` 和 `1`，并严格递增。若分布说明不足以确定坐标，通过 `case-dict` 补充设置后再生成网格。

在当前算例根目录，使用 ChatFGM 工作台配置的 Python 调用工具。`$caseName` 使用 `04` 中的完整工况目录名。以处理一个工况为例。

```powershell
& $env:CHATFGM_PYTHON (Join-Path $env:CHATFGM_TOOLBOX_DIR 'tools/tabulation/interpolate_c/interpolate_c.py') `
    --case $caseName `
    --c-grid @cGrid
```

处理多个选定工况时，每个工况传一次 `--case`。处理 `04` 中全部已有归一化样本的工况时，可省略该参数。

### Result Verification

1. 检查工具退出码。运行成功后，在 `C-tabulation/05-c_interpolated/<case_name>/` 核对输出。每个目标 `C` 对应一个 `prof_c*.h5`，核对文件数量和各文件内保存的标量 `C` 与本次网格一致。
2. 核对各文件的 `Z` 坐标与对应工况的 `04` 样本一致。抽查表格字段及单位，确认字段沿 `Z` 的长度与网格点数一致，两侧入口值与排序后首条剖面的对应入口值一致。

**预期交付**为各工况核对通过的 `Z–C` 表。每个文件包含一个目标 `C` 下整套 `Z` 网格上的数据。

## Final Deliverables

一并交付 `03` 和 `05` 的结果前，核对同一工况的 `yc_bounds.h5` 与各 `prof_c*.h5` 的 `Z` 网格一致。

制表完成后，按工况一并交付以下两项。

- **Yc 上下界**。`C-tabulation/03-yc_bounds/<case_name>/yc_bounds.h5`
- **Z–C 表**。`C-tabulation/05-c_interpolated/<case_name>/` 中的全部 `prof_c*.h5`

## Failure Handling

发现调用失败，先向用户说明报错、影响范围，以及接下来准备检查什么。

工具调用失败时，查看 `stderr`，确认受影响的步骤和工况。向用户说明报错和排查范围，再根据报错核对该步骤的输入、调用参数和已有产物。暂停依赖受影响结果的后续步骤。

问题解决后，复用已完成且核对通过的结果，用 `--case` 指定仍需处理的工况。需要重做已有产物时，按主 skill 的[已有产物的核对、复用和重做](../SKILL.md#已有产物的核对复用和重做)处理，并在重做后[核对下游产物](../SKILL.md#重做后检查下游产物)。
