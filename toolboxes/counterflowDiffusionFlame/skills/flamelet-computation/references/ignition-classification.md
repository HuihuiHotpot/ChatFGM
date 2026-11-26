# 着火判定与分流

着火判定与分流是火焰面求解流程的第三步，接在正式瞬态着火计算之后。读取各正常完成工况的求解记录，判断是否着火，并生成按工况组织的着火清单。

已着火且末态达到稳态判据的工况，提供最终剖面作为稳态延拓初值。积分时限内未着火的工况列为冻结火焰面（FFM）计算候选。后续整理火焰面结果时，可根据着火清单标注各工况的着火状态。

## Inputs and Checks

- **正式瞬态状态表**位于 `B-flamelet/02-transient_ignition/formal/_status.csv`。确认文件可读取。
- **工况求解记录**位于 `B-flamelet/02-transient_ignition/formal/<工况目录名>/case_status.txt`。确认待判定工况的求解记录可读取。
- **编号剖面**位于同一工况目录。对已着火且末态判稳的工况，确认目录下有 `prof<数字>.h5` 格式的编号剖面。

## Execution

在当前算例根目录，使用工作台配置的 Python 调用着火判定工具。

```powershell
& $env:CHATFGM_PYTHON (Join-Path $env:CHATFGM_TOOLBOX_DIR 'tools/flamelet/ignition_classification/classify_ignition.py')
```

## Result Verification

1. 工具运行结束后，检查退出码。若返回了 JSON 摘要，一并读取。发现调用失败时，按 `Failure Handling` 处理。
2. 读取本次生成的 `B-flamelet/ignition_status.csv`，按清单确定各分支的工况。

**交付**着火清单及其路径，并向用户汇报各分支的工况和数量。

- **稳态延拓**选取 `ignited=True` 且 `restart_file` 已填写的工况，使用 `restart_file` 指向的剖面作为延拓初值。
- **冻结火焰面（FFM）**选取 `ignited=False` 的工况，即正式瞬态正常完成且在积分时限内未着火的工况。
- `ignited=True` 且 `restart_file` 为空的工况，汇报为已着火、尚无可交接的延拓初值。

## Failure Handling

发现调用失败时，先告诉用户目前看到的问题、影响范围，以及接下来准备检查什么。

- **工具调用失败**。查看 `stderr`，并结合工具已返回的摘要或报告，根据报错检查调用参数、输入文件或 Python 环境。暂停受该问题影响的后续调用。

向用户说明排查结果和处理建议。需要用户补充信息或确认方案时，按工具箱 `AGENTS.md` 的规则与用户确认，再按确认的范围处理。通过 `case-dict` 更新错误记录和已确认的算例设置。

问题解决后，按需重试着火判定。若已有 `ignition_status.csv`，重试前先向用户说明本次会重新生成整份清单。经用户确认后，按[已有产物的核对、复用和重做](../SKILL.md#已有产物的核对复用和重做)处理旧清单，再调用工具。核对新清单后，立即按[重算后检查下游产物](../SKILL.md#重算后检查下游产物)检查依赖旧清单的后续结果。
