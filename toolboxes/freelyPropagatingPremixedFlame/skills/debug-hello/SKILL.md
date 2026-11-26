---
name: debug-hello
description: 仅用于 ChatFGM 调试。当用户要求测试技能加载、运行调试问候或调用示例工具时，执行问候脚本并报告实际结果。
---

# 调试问候

这是调试示例，不执行 FGM 计算。

1. 找到工具 `tools/debug_hello.py`。相对路径以本 SKILL.md 所在目录为基准解析（`../../tools/debug_hello.py`）；工作台也会在 `CHATFGM_TOOLBOX_DIR` 中提供工具箱的真实目录。资源始终在工具箱原位读取，不复制到项目中。
2. 使用工作台为该工具箱配置的 Python 环境执行工具，不要使用系统 `python`，也不要手动 activate。解释器的绝对路径在 `CHATFGM_PYTHON` 中，PATH 已优先指向同一环境。例如在 PowerShell 中：

   ```powershell
   & $env:CHATFGM_PYTHON "<工具绝对路径>\debug_hello.py" --message "你好，ChatFGM"
   ```

   用户指定了问候文字时，通过 `--message` 原样传入，避免把用户文字拼成额外命令。
3. 检查退出码及标准输出。成功时返回 JSON，其中 `marker` 为 `CHATFGM_DEBUG_TOOL_OK`，`message` 为传入的文字。
4. 向用户报告实际返回的标记与文字。找不到工具、解释器不可用或执行失败时说明原因，不编造成功结果。

工具只输出 JSON，不读取项目文件，不写入文件，不访问网络。
