# 2026-11-12 维护记录：关闭已删除目录、持续写入日志与覆盖非空目录

本次修复三个已确认缺陷，沿用现有界面与交互，不新增产品入口。

## 1 项目目录被外部删除后的关闭流程

根因：

- `ChatService.listRunningTasks` / `stopTask` 通过 `ProjectService.getProjectRoot` 校验项目，该校验要求项目目录存在；目录删除后任务区显示路径错误，`继续` 被置灰。
- 文件同步把“目录已删除”当作普通扫描失败，每 2.5 秒重复推送可见失败提示。
- 关闭流程无条件保存工作区并等待最终同步，因此目录消失后必然失败。

实现：

- 新增 `getProjectAvailability`（主进程服务、IPC、preload、前端能力）：区分 `available` / `missing` / `unreadable`。`unreadable` 保留具体错误和重试入口。
- 任务查询和停止改为只校验项目登记（`requireRegisteredProject`），不再要求目录存在；停止仍按实际 run/conversation owner 路由。
- `ProjectFileSyncService.finalize` / `run` / `schedule` 对 `missing` 直接完成并忘记该项目的扫描状态，不再产生同步失败事件；`unreadable` 继续报错。
- 关闭弹窗在打开期间轮询任务与目录状态。目录已删除且无运行任务时：
  - 弹窗显示“项目目录已删除”、目标路径，以及有未保存编辑时“继续关闭会丢弃这些编辑”；
  - 有未保存编辑时只保留“不保存并继续”，不再提供不可用的“保存并继续”；
  - 点击继续后重新确认目录状态，跳过对话/工作区保存与最终磁盘同步，丢弃该项目的未保存编辑并返回欢迎页；
  - 清除同步提示和外部读取失败提示。
- 打开/新建项目、退出时的旧项目保存与同步也在目录缺失时跳过；暂时不可读仍按原错误阻塞并允许重试。

## 2 求解期间打开持续追加的日志与文本编码兼容

根因：

- `readFileState` 用 `readFileSync` 后比较大小/修改时间，求解器持续追加时必然触发 `file-changed`。
- 日志末尾尚未写完的多字节字符会让严格解码抛错。
- 只支持 UTF-8；UTF-16 直接拒绝，GBK/GB18030 无法打开，保存也只能写回 UTF-8。

实现：

- `backend/filesystem/text.ts` 改为打开文件后按初始大小读取一致前缀：允许追加（日志场景），同尺寸原地重写重试一次，文件身份变化或截短仍拒绝。
- UTF-8 / GB18030 使用流式严格解码：末尾不完整多字节序列留到下一次读取，不显示替换字符；UTF-16 按 BOM 识别 LE/BE 并保留未配对代理项。
- 编码检测顺序：UTF-8 BOM → UTF-16 BOM → 无 BOM UTF-8 → GBK/GB18030；保留 NUL 二进制拒绝。
- 新增 `backend/filesystem/gb18030.ts`：用同一 ICU 解码器生成的两字节映射和四字节线性区间进行无损编码；生成器在 `test/backend/generate-gb18030-table.mjs`。
- 保存沿用磁盘检测到的编码、BOM 和换行；无法无损写回（不完整代理项或 GB18030 不可表示字符）返回 `encoding-lossy`，原文件不变。版本冲突、`force` 二次校验和二进制保护保持不变。
- `CodeEditor` 在内容追加时：用户位于底部则跟随最新输出，否则恢复原阅读位置；不改动普通编辑行为。

## 3 选择非空目录新建项目

根因：

- `pickProjectFolder` 只在空目录返回旧项目提示，`createProject` 对非空目录直接报 `project-folder-not-empty`。

实现：

- `FolderSelection` 增加 `directoryEmpty`，非空目录也返回旧项目记录。
- 非空目录首次创建返回 `project-overwrite-confirmation-required`，携带旧项目 ID；新建弹窗显示覆盖确认：目标路径、全部旧内容将被移除、使用所选 Flamelet 完整模板重建；存在旧记录时说明旧对话/草稿/恢复状态会清除。
- 用户确认后 `confirmOverwrite=true`，`ProjectCreation` 在目标同级的暂存目录构造完整模板，把原目录改名为备份、发布模板，再提交新的项目 ID 并删除旧记录（对话、草稿等由外键级联清除）。
- 初始化/登记失败通过持久化 journal 恢复原目录；取消、初始化失败和登记失败都保留原内容与旧记录。成功提交后删除备份目录，目录中只保留新模板。
- Windows 目录改名增加短暂瞬时共享冲突重试，避免刚写完暂存模板时的偶发 `EPERM`。

## 4 验证

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| `npm run typecheck` | 通过 | 本次命令输出 |
| `npm run build:desktop` | 通过 | `dist/` 构建输出 |
| `npx eslint app backend test/frontend test/desktop` | 通过 | 本次命令输出 |
| 前端 UI 全量 | 273/273 通过 | `test/results/maintenance-20261112/frontend-final/results.json` |
| 前端关闭/新建定向（最终构建） | 25/25 通过 | `test/results/maintenance-20261112/frontend-final-build2/results.json` |
| 新增桌面回归（最终构建） | 8/8 通过 | `test/results/maintenance-20261112/desktop-final-build2/results.json` |
| 桌面全量 | 92 通过 / 3 失败 | `test/results/maintenance-20261112/desktop-final/results.json` |
| `npm run test:storage` | 81 通过 / 1 失败 | `test/results/backend-step1/storage/2026-11-12T06-51-20-128Z-39184/result.json` |

新增用例：

- `test/frontend/leave.spec.ts`：删除目录后无任务/有任务、有未保存编辑、暂时不可读四类关闭流程。
- `test/frontend/projects.spec.ts`：非空目录覆盖确认、取消、初始化失败和确认重建。
- `test/desktop/16-maintenance-20261112.spec.ts`：真实桌面上的目录删除关闭、任务查询/停止、持续追加日志（首次打开、阅读位置、跟随底部、未完成多字节字符）、五种编码读取/回存/无损拒绝、非空目录取消/确认/旧记录清理/初始化失败。

## 5 已知未通过项与边界

- 桌面 `06-step2` 的模板扫描用例依赖工作区中已被删除的 `toolboxes/counterflowDiffusionFlame/standardCase/**/.gitkeep`，该工作区改动早于本次修复，未由本次改动引入。
- 桌面 `13-step6-chat` 的附件引用用例仍期望模型输入包含文件正文；当前工作区已改为只传路径，这是既有维护改动，未由本次改动引入。
- `13-step6-chat` 多对话重启用例在全量顺序运行中曾失败一次，单独重跑通过，按环境时序波动记录。
- `npm run test:storage` 的失败项为 `chat-service-records-real-toolbox-environment-and-protects-it`（断言 `counterflowDiffusionFlame/tools/debug_hello.py` 存在，但该文件在当前工作区已被删除），与本次修改无关。
- `npm run lint` 会扫描 `test/<历史轮次>/source`、临时编译缓存等历史证据副本并报解析错误；对 `app`、`backend`、`test/frontend`、`test/desktop` 的定向 lint 通过。
- 未实测：真实 Ember/Python 求解器持续写日志（用等价持续追加写入模拟）；真实运行任务与目录删除同时发生的桌面场景（桌面验证任务查询/停止 API，运行中任务的界面组合由前端回归覆盖）；UTF-16 无 BOM、其他区域编码；项目登记事务失败的桌面注入（初始化失败和持久化 journal 恢复已覆盖）。
