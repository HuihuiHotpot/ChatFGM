# ChatFGM 前端开发说明

## 当前范围

前端已完成第 1 步界面骨架、第 2 步项目管理/目录树/文件标签、第 3 步的文本与代码/Markdown/图片查看器、第 4 步的 CSV/HTML/H5 查看器、第 5 步的项目内 Agent 对话，以及第 6 步的全局依赖设置：

- 欢迎页、顶栏与 ChatFGM 菜单、三栏工作台、状态栏。
- 左右面板拖拽、键盘调整、双击复位、完全隐藏与恢复。
- 新建项目、从文件夹打开项目、最近项目打开、关闭项目。
- 离开当前项目前的未保存文件与运行任务确认。
- 项目目录树、右键菜单、新建/重命名/删除/剪切/复制/粘贴、复制路径、资源管理器显示。
- 文件标签、内容脏标记、未保存关闭确认、标签溢出滚动。
- 按项目缓存的目录展开、选中项、打开标签、活动标签和剪贴板状态；A → B → A 可恢复。
- 正式文本与代码查看器：行号、语法高亮、编辑、Ctrl+S、快照保存、选区/滚动恢复。
- 正式 Markdown 查看器：预览/源码、实际表格/代码/公式渲染、净化、局部滚动、本地图片。
- 正式图片查看器：真实图片解码、缩放、适应视口、拖动平移、加载/失败反馈和显示 URL 清理。
- 每个文档独立保存文本选区/滚动、Markdown 模式及预览滚动、图片缩放/平移状态。
- 正式 CSV 查看器：前端 RFC 4180 风格解析、Excel 式只读网格、选区和原值栏、复制、列宽、内部滚动与按文件状态。
- 正式 HTML 查看器：受控预览入口、隔离 iframe、刷新、失败保留、页面实例跨标签/项目保留和句柄释放。
- 正式 H5 查看器：数据集列表、标量/一维/二维网格、空/不支持类型、无损原值、范围读取及按数据集状态。
- 正式桌面入口已接入工作区持久化：全局面板布局、项目目录展开/选中、标签顺序/活动标签、六类查看器状态和未保存文本恢复副本；应用启动仍显示欢迎页，不自动打开上次项目。
- 正式桌面入口的重启退出使用统一退出协调：无未保存编辑直接最终提交后退出；有未保存编辑复用离开确认的取消、保存并退出、不保存并退出文案。
- 正式 Agent 对话：项目内多段对话、历史切换、草稿与设置隔离、Markdown 消息、运行/工具/步骤展示、停止、后台通知及目录引用。
- 对话能力通过可选 `capabilities.chat` 注入；正式桌面入口已注入真实实现，其他入口没有该能力时明确显示未接入，不生成模拟模型或回复。
- 正式对话的权限执行、真实流式消息、历史恢复、审批、附件/截图、提交幂等和退出保存等待由后端第 6/7 步提供；同一对话的用户状态使用独立版本保存。
- 历史读取不会把当前实例仍受连接控制的活跃运行降级为待核实；当前运行继续显示停止按钮。助手回复写库失败时使用现有运行 trace/错误提示展示保存失败，不伪造回答已保存；存储恢复后通过原 thread 历史核实，不重发消息或新增 turn。
- 全局依赖设置：Codex CLI 路径/浏览/检测连接与版本、ChatGPT 登录/退出与真实账号状态、自定义 API 服务增删改/密钥遮蔽/连接测试/当前服务、Flamelet 工具箱扫描与每工具箱独立运行环境。
- 依赖设置的保存、取消、加载失败重试、检测等待/失败重试、迟到结果隔离、未完成新增服务确认和跨弹窗协调。
- 设置保存后刷新全局对话能力上下文：已有对话继续绑定原服务并保留历史/草稿/设置，新对话使用保存后的当前服务；新项目工具箱来源与设置扫描一致。
- 依赖设置通过可选 `capabilities.settings` 注入；正式入口没有该能力时顶栏设置按钮保持禁用，不出现样例服务、假登录或模拟扫描结果。
- 第 7 步：三档权限由真实运行层执行；审批请求在运行轨迹显示“等待审批”，对话区提供“查看审批”和现有 Modal 风格的审批弹窗（批准/拒绝，关闭或 Esc 仅暂不处理）。权限审批展示读取范围、写入范围、禁止路径、网络开关与目标、授权范围；命令附加权限同样展示。
- 第 7 步：未绑定工具箱的普通文件夹仍可打开、浏览和普通对话，对话区提供简洁提示和“选择工具箱”；绑定只保存类型，不初始化模板或覆盖文件。
- 第 7 步：Agent 改盘后由后端 `projectUpdates` 事件原地同步目录树、标签和引用；干净文本/Markdown/CSV 自动刷新，图片/H5 重新读取，HTML 保留实例并提示更新。每个文件独立关联读取版本，不同文件更新互不取消；读取失败自动重试有限次数，仍失败时使用现有提示条汇总所有待恢复文件并显示“重试读取”，单个文件恢复不会清除其他文件的恢复入口，重试前重新校验文档实例、编辑状态和项目。
- 第 7 步：后端执行连接按对话归属；前端不感知进程切换。读取历史/切换标签不主动重启执行连接；同 thread 环境更新在发送前由后端后台准备。未知回执只有在历史中的 run 已终态且后端已不再返回 pending submission 时才自动收敛；历史中发现但未终态的未知 run 保留“核实上次发送”，避免把待核实误报为已恢复。
- 第 7 步：保存冲突提供取消并保留编辑、重新载入磁盘、明确确认覆盖；删除文件后的脏文档保留并提供“另存为”。最终文件同步失败会留在既有离开/退出确认中显示原因并可重试；关闭/退出会等待 `flushProjectSync` 完成后才完成，后台扫描失败使用提示条“重试同步”。
- 第 7 步：工具箱类型由 `toolboxes/` 下一级文件夹名决定，无 `toolbox.json`；AGENTS/skills/tools 原位加载，Python 环境按工具箱在设置中配置。

第 1 步的面板拖拽收尾、普通/紧凑弹窗尺寸、遮罩关闭规则、焦点陷阱与背景隔离均保留，并有回归测试。

本阶段已完成正式前端与能力契约；桌面宿主、SQLite、真实 Codex app-server、对话/设置持久化、工作区恢复、审批执行和退出协调见 `docs/backend-development.md`（本节只描述前端行为）。正式桌面入口注入项目/文件、查看器、工作区、设置和 Agent 对话能力；测试预览中的依赖数据仍为内存模拟。浏览器正式入口不注入业务能力。

## 环境要求

- Node.js `>= 22.12.0`（已在 Node.js 24 / npm 11 下验证）。
- npm。
- Windows 上已安装 Microsoft Edge。Playwright 使用 `channel: "msedge"` 调用系统 Edge，不额外下载浏览器。

## 安装与常用命令

```powershell
npm install

npm run dev          # 正式前端开发服务器，http://127.0.0.1:5173/
npm run typecheck    # TypeScript 严格类型检查
npm run lint         # ESLint
npm run build        # 类型检查后构建到 dist/
npm run preview:test # 测试预览服务器，http://127.0.0.1:5174/
npm run test:ui      # Playwright 交互验收，自动启动/复用 5173、5174
```

`npm run test:ui` 使用 `test/playwright.config.ts`。如果 5173/5174 已有兼容的 Vite 服务，会复用已有服务。

## 页面入口

### 正式入口

`http://127.0.0.1:5173/`

正式入口已注册正式查看器实现；普通浏览器入口不注入任何后端能力，因此默认显示欢迎页并保持新建、打开、最近项目、关闭、依赖设置和对话操作禁用。这是浏览器预览的明确状态，不使用演示数据、隐藏入口或模拟成功。

真实 Electron 入口在启动信息桥校验成功后设置 `data-desktop-shell="true"`，由桌面外壳启用 Window Controls Overlay 安全区、顶栏拖动区和原生窗口按钮布局；同时注入真实项目、目录和文本文件能力（新建/打开/最近项目、工具箱模板、目录树、文件操作、文本保存、复制路径和资源管理器定位），以及第 3 步的图片字节、Markdown 本地图片、HTML 资源服务和 H5 解析能力，第 4 步的全局布局/项目工作区/恢复副本/退出协调能力，以及后端第 6/7 步的 Agent 对话、权限审批、文件同步、工具箱绑定与全局依赖设置。普通浏览器入口没有该属性，保持原有 52px 顶栏和点击行为。对话能力仍以可选 `capabilities.chat` 形式存在，缺失时显示未接入；详见 `docs/backend-development.md`。

### 测试预览入口

```text
http://127.0.0.1:5174/test/frontend/preview.html
```

测试预览在 `test/frontend/preview-main.tsx` 中创建 `TestCapabilities`，通过 `App` 的 `capabilities` prop 注入内存实现：

- `preview.html?viewer=1` 使用全部正式查看器，第 3/4 步验收和视觉截图均使用此入口。
- 不带 `viewer=1` 的入口保留第 2 步测试渲染器，仅用于已有文件标签/保存流程回归；它不能作为正式查看器验收。
- 测试适配器、测试渲染器、样例图片、CSV/H5 数据和 HTML 资源只存在于 `test/`，`app/main.tsx` 仍只渲染无能力的 `<App />`。

测试预览默认是成功场景：

- 最近项目：`standard-case`、`mesh-validate`、`ignition-transient`。
- 项目树包含多级目录、同名 `notes.txt`、用于标签溢出的长文件名、Markdown 验收文档、CSV 边界样例、PNG/JPEG/GIF/WebP/BMP/SVG 图片、H5 数据集样例和 HTML 预览文件。
- `test/html-fixtures/scene/` 是一个真实静态网页，包含独立 CSS、脚本、SVG 图片和 JSON 数据；测试 Vite 中间件仅对该目录提供带 CORS 的原始静态响应，避免 Vite 向预览网页注入客户端代码。
- 新建项目默认选择一个新的测试文件夹；从文件夹打开时会在测试项目之间切换。
- 测试文件夹、文本、CSV、H5 结构化数据和图片均为内存数据，不会操作真实磁盘。

#### 场景参数

测试预览支持以下仅用于验收的 URL 场景：

| URL | 用途 |
| --- | --- |
| `preview.html` | 默认成功流程（第 2 步测试渲染器） |
| `preview.html?viewer=1` | 正式查看器成功流程 |
| `preview.html?scenario=folder-cancel` | 新建/打开项目的文件夹选择器取消 |
| `preview.html?scenario=folder-error` | 文件夹选择器返回错误 |
| `preview.html?scenario=open-error` | 打开项目失败 |
| `preview.html?scenario=create-error` | 创建项目失败 |
| `preview.html?scenario=save-error` | 保存文件失败 |
| `preview.html?scenario=tasks` | 三个测试项目带运行中任务 |
| `preview.html?scenario=delay` | 文件夹选择、项目打开/创建、文本/二进制读取、HTML 入口、H5 数据集/范围、保存、最近项目和工具箱加载增加延迟 |

`viewer=1` 入口同时启用第 5 步测试对话能力和第 6 步测试依赖设置，使用中性的测试服务/模型标识（`service-alpha`、`service-beta`、`test model` 等）、测试消息、虚构账号状态和可控运行层；不带 `viewer=1` 的第 2 步测试入口没有 chat/settings 能力，用于保留旧骨架回归和正式无能力状态。测试服务密钥均为虚构测试值，接口快照只返回 `hasKey`，不包含密钥原文。

对话测试桥的主要控制（只在 `test/` 中）：

```js
window.__chatfgmTest.setChatScenario('accepted-lost'); // normal | task | fail | manual | unknown-result | accepted-lost
window.__chatfgmTest.setChatRunDelay(800);
window.__chatfgmTest.setChatStopDelay(300);
window.__chatfgmTest.setChatReceiptDelay(1200); // updates emitted before a late receipt returns
window.__chatfgmTest.setChatLoadSnapshotMode('request'); // capture at request start, not completion
window.__chatfgmTest.setChatLoadSnapshotOverride('standard-case', 'conv-id', staleSnapshot);
window.__chatfgmTest.setChatService('service-beta');
window.__chatfgmTest.setChatConnection('disconnected', '连接中断'); // drops message/run/snapshot events
window.__chatfgmTest.setChatModelAvailability('model-a', false, '模型不可用');
window.__chatfgmTest.setFailure('sendChatMessage', '发送失败');
window.__chatfgmTest.setCancelled('sendChatMessage', true);
// 下一次 sendMessage 在命中回执缓存之前失败；用于重试未发出边界。
window.__chatfgmTest.setChatNextSendFault({
  kind: 'error',
  message: '本次重试未发出',
  acceptance: 'not-sent',
});

window.__chatfgmTest.getChatConversation('standard-case', 'conv-standard-config');
window.__chatfgmTest.getChatSummaries('standard-case');
window.__chatfgmTest.getChatSaveRequests();
window.__chatfgmTest.getChatLoadRequests();
window.__chatfgmTest.getChatSendInputs();
window.__chatfgmTest.getChatAcceptedRuns('standard-case');
window.__chatfgmTest.getChatReturnedSubmissionIds();
window.__chatfgmTest.getChatEmittedUpdates();
window.__chatfgmTest.getChatSubscriberCount();
window.__chatfgmTest.getChatReleasedAttachmentTokens();
window.__chatfgmTest.emitChatSnapshot('standard-case', 'conv-standard-config');
window.__chatfgmTest.emitChatSnapshotRaw('standard-case', staleSnapshot);
window.__chatfgmTest.emitChatMessageUpdate(...);
window.__chatfgmTest.emitChatRunUpdate(...);
window.__chatfgmTest.emitChatRunRaw('standard-case', 'conv-id', staleRun);
window.__chatfgmTest.completeChatRun(...);
```

依赖设置测试桥的主要控制（只在 `test/` 中）：

```js
window.__chatfgmTest.setSettingsCliSelection({ status: 'cancelled' });
window.__chatfgmTest.setSettingsCliSelection({
  status: 'success',
  selection: { path: 'C:\\TestTools\\codex-browsed.exe' },
});
window.__chatfgmTest.setSettingsCliDetectionOutcome('error');
window.__chatfgmTest.setSettingsCliRuntime({
  state: 'error',
  path: 'C:\\TestTools\\codex.exe',
  message: '测试场景：CLI 连接异常。',
});
window.__chatfgmTest.setSettingsSavedCliPath('C:\\TestTools\\codex.exe');

window.__chatfgmTest.setSettingsToolboxSelection({ status: 'cancelled' });
window.__chatfgmTest.setSettingsToolboxDetectionOutcome(
  'counterflowDiffusionFlame',
  'error',
);
window.__chatfgmTest.setSettingsApiTestOutcome('error');
window.__chatfgmTest.setSettingsApiTestRejection(
  'service-alpha',
  '测试场景：连接测试 Promise 拒绝。',
);
window.__chatfgmTest.setSettingsApiTestRejection('service-alpha', null);
window.__chatfgmTest.setSettingsAuthOutcome('error');
window.__chatfgmTest.setSettingsChatGptAccount({
  status: 'logged-in',
  email: 'test-user@example.test',
});

window.__chatfgmTest.getSettingsSnapshotValue();
window.__chatfgmTest.getSettingsRuntimeValue();
window.__chatfgmTest.getSettingsSaveRequests();
window.__chatfgmTest.getSettingsCliDetectionInputs();
window.__chatfgmTest.getSettingsApiTestInputs();
window.__chatfgmTest.getSettingsToolboxDetectionInputs();
window.__chatfgmTest.getSettingsToolboxScanCount();
window.__chatfgmTest.getSettingsAuthCounts();
window.__chatfgmTest.getSettingsSubscriberCount();
window.__chatfgmTest.getSettingsCancelPendingCount();
window.__chatfgmTest.getChatContextSnapshot();
```

测试适配器按**已保存**的模型接入模式生成对话上下文：ChatGPT 模式使用稳定的 `chatgpt-test-service`/`ChatGPT Test Model` 测试身份，实际账号未登录、授权中或 CLI 不可用时返回断开状态和原因；自定义 API 模式只使用已保存的当前服务，服务为空时返回稳定的 `settings-api-unavailable` 不可用上下文，不回退旧服务。模式草稿在保存前不改变上下文；登录/退出等实际账号变化只在已保存 ChatGPT 模式下重新计算可用性。已有对话和运行快照不因上下文切换重写。该规则只在 `test/` 适配器中，正式组件不识别 ChatGPT 或测试服务名。

测试适配器不执行真实推理或 CLI/模型/工具箱操作；`sendMessage` 只生成内存消息、运行、工具与步骤数据，设置接口只返回内存配置、虚构账号状态和测试检测结果，供 UI 验收。

“失败后重试成功”和精确的延迟/任务状态通过测试桥手动触发：

```js
window.__chatfgmTest.setFailure('openProject', '打开项目失败：测试场景。');
window.__chatfgmTest.setFailure('openProject', null); // 清除，重试

window.__chatfgmTest.setDelay('readFile', 1200);
window.__chatfgmTest.setDelay('readBinaryResource', 800);
window.__chatfgmTest.setFailure(
  'readBinaryResource',
  '图片读取失败：测试场景。',
);
window.__chatfgmTest.setDelay('getHtmlPreviewUrl', 900);
window.__chatfgmTest.setFailure(
  'getHtmlPreviewUrl',
  '网页预览入口失败：测试场景。',
);
window.__chatfgmTest.setCancelled('getHtmlPreviewUrl', true);

window.__chatfgmTest.setDelay('listH5Datasets', 700);
window.__chatfgmTest.setDelay('readH5DatasetRange', 700);
window.__chatfgmTest.setFailure(
  'readH5DatasetRange',
  'H5 数据读取失败：测试场景。',
);
window.__chatfgmTest.getLastHtmlPreview();
window.__chatfgmTest.getReleasedPreviewHandles();
window.__chatfgmTest.getH5RangeRequests();

window.__chatfgmTest.setFolderPickOutcome('open', {
  status: 'cancelled',
});
window.__chatfgmTest.setFolderPickOutcome('open', {
  status: 'error',
  message: '选择项目文件夹失败。',
});
window.__chatfgmTest.setFolderPickOutcome('open', {
  status: 'success',
  folder: {
    path: 'C:\\ChatFGM\\projects\\standard-case',
    pathKey: 'c:\\chatfgm\\projects\\standard-case',
    name: 'standard-case',
  },
});

window.__chatfgmTest.setRunningTasks(
  'standard-case',
  [{ id: 'task-1', title: '运行中的任务', status: '运行中' }],
);
window.__chatfgmTest.completeTasks('standard-case');
```

可用 failure/delay 操作名：

```text
loadRecentProjects, listToolboxes,
pickFolder:create, pickFolder:open,
createProject, openProject, readFile, readBinaryResource,
getHtmlPreviewUrl, releaseHtmlPreview,
listH5Datasets, readH5DatasetRange,
createEntry, renameEntry, deleteEntry, pasteEntry,
copyText, revealPath, saveFile,
listRunningTasks, stopTask,
getSettingsSnapshot, saveSettings,
pickCliExecutable, detectCli, testSettingsService,
startChatGptLogin, logoutChatGpt,
pickToolboxEnvironment, detectToolboxEnvironment,
scanSettingsToolboxes
```

`window.__chatfgmTest` 只在测试预览存在，正式构建没有该对象。测试预览也不使用 `?demo` 或生产可访问的模拟后端。

### 通用组件验收入口

`http://127.0.0.1:5174/test/frontend/components.html` 仅用于通用按钮、菜单、弹窗的自动化和截图，不是正式应用的一部分。

## 目录结构

```text
ChatFGM/
  app/
    main.tsx                 正式入口，<App />
    App.tsx                  项目流程、能力调用、弹窗与会话编排
    types.ts                 项目与最近项目类型
    services/capabilities.ts 前端与后端的最小能力契约
    state/
      app.ts                 当前项目、项目会话缓存、最近项目
      workspace.ts           单项目树/标签/展开/选中/剪贴板状态
      layout.ts              面板宽度、显隐、拖拽和响应式约束
    components/
      ui/                    Button、IconButton、Menu、Modal、Notice、图标
      layout/                AppHeader、PanelLayout、Splitter、StatusBar
    features/
      welcome/               欢迎页、最近项目
      projects/              新建项目、离开确认
      settings/              全局依赖设置弹窗与三类配置面板
      file-tree/             目录树、树菜单、删除确认
      workspace/             工作区、标签栏、关闭标签确认
      viewers/               六类正式查看器、HTML iframe 宿主与网格工具
  test/
    fixtures/project-fixtures.ts
    fixtures/settings-fixtures.ts
    fixtures/image-fixtures.ts
    fixtures/h5-fixtures.ts
    html-fixtures/scene/     真实 HTML/CSS/JS/SVG/JSON 预览资源
    fixtures/step3/          第 3 步图片、网页和 HDF5 真实样本
    frontend/
      preview-main.tsx       测试预览注入点
      test-capabilities.ts   内存能力、故障/延迟/任务控制
      *.spec.ts
    results/                 截图、HTML 报告、失败附件
  backend/                   第 1/2/3 步真实能力实现
  references/                UI 原型
  docs/
  dist/                      构建产物
```

## 能力接口与后端职责

`app/services/capabilities.ts` 定义最小能力接口。所有异步操作返回显式结果：

```ts
type ServiceResult<T> =
  | { status: 'success'; value: T }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };
```

接口分组：

- 项目：`loadRecentProjects`、`listToolboxes`、`pickProjectFolder('create' | 'open')`、`createProject`、`openProject`。
- 目录：`readFile`、`readBinaryResource`、`createEntry`、`renameEntry`、`deleteEntry`、`pasteEntry`、`copyText`、`revealPath`。
- 查看器：`readBinaryResource`、`getHtmlPreviewUrl`、`releaseHtmlPreview`、`listH5Datasets`、`readH5DatasetRange`。桌面入口已正式注入，方法仍保留可选属性，使浏览器/测试入口无需伪造实现。
- 文件会话：`saveFile`。
- 任务：`listRunningTasks`、`stopTask`。
- 对话（可选）：`capabilities.chat`，见第 5 步说明；第 7 步新增 `respondApproval`。
- 依赖设置（可选）：`capabilities.settings`，包括 `getSnapshot`、`saveSettings`、`pickCliExecutable`、`detectCli`、`pickToolboxEnvironment`、`detectToolboxEnvironment`、`testServiceConnection`、`scanToolboxes`、`startChatGptLogin`、`cancelChatGptLogin`、`logoutChatGpt`、`subscribeUpdates`，以及可选的 `cancelPendingOperations`。
- 第 7 步项目能力（可选）：`bindProjectToolbox`、`saveFileAs`、`subscribeProjectUpdates`、`flushProjectSync`、`subscribeProjectSyncFailures`。`ToolboxOption` 的 `id`/`label` 都是工具箱文件夹名，`error` 给出该文件夹不可用的具体原因。

`readBinaryResource({ projectId, fileIdentity, relativePath? })` 是第 3 步新增的最小二进制读取能力，返回 `{ bytes: Uint8Array, mime: string }`：

- 直接打开图片时按 `projectId + fileIdentity` 读取。
- Markdown 本地图片传入文档的 `fileIdentity` 与原始引用 `relativePath`，路径解析和项目范围校验完全由后端负责；前端不会拼装 `file://` 地址。
- 图片不能通过 `readFile` 文本通道伪装读取；后端会校验扩展名与内容，单文件上限 32 MiB。
- 桌面入口的真实 HTML 入口使用 `chatfgm-preview://` handle，`url` 不含项目绝对路径；iframe 保持 `allow-scripts allow-forms`（不含同源）并按项目 + 文档实例保活/释放。H5 单次窗口最多 80×24、最多 1920 单元格，`raw` 是原值/复制依据。

第 4 步新增的最小能力：

- `getHtmlPreviewUrl({ projectId, fileIdentity })` 返回 `{ url, handle? }`。`url` 必须是后端控制的预览入口，不能是 `file://`；`handle` 仅在资源有生命周期时分配。
- 可选 `releaseHtmlPreview({ projectId, fileIdentity, handle })` 释放入口句柄；静态地址没有句柄时前端不调用。
- `listH5Datasets({ projectId, fileIdentity })` 返回 `{ datasets, fileInfo? }`。数据集元信息包含完整 `path`、`dtype`、`shape`、`kind`、`supported` 和可选 `reason`。
- `readH5DatasetRange({ projectId, fileIdentity, datasetPath, start, shape })` 返回同路径、起点、shape 的二维网格。单元格 `{ raw, display?, kind }` 的 `raw` 是精确原文，`display` 只是显示提示。

第 6 步设置契约的关键边界：

- `SettingsSnapshot` 同时返回 `saved` 与 `runtime`：`saved` 是后端确认的全局配置；`runtime` 是 CLI 实际连接状态、ChatGPT 实际账号状态和工具箱环境检测状态。两者不能互相伪造，前端不能用路径、URL 格式或本地标记推断成功。
- 自定义 API 服务只返回 `{ id, name, baseUrl, hasKey }`。密钥原文不进入渲染层；`SaveSettingsInput` 中省略 `key` 表示保留已保存密钥，携带 `key` 表示替换；新增服务必须携带密钥。测试连接使用 `keepSavedKey` 明确请求后端使用已保存密钥。
- `subscribeUpdates` 返回取消函数；CLI 检测、登录、退出和环境检测的迟到或外部变化通过它更新实际状态。App 在能力实例生命周期内保持一个订阅并在卸载时清理，StrictMode 不重复监听。
- `saveSettings` 成功后返回后端确认的完整快照。前端只用该结果更新全局生效配置、关闭弹窗并刷新对话上下文；保存失败/取消保留草稿，不能用本地推测覆盖后端配置。
- `cancelChatGptLogin` 返回取消后的实际账号状态。已完成登录/退出不会被“取消设置”回滚；未完成的授权在关闭设置时取消，旧 Promise 回调不能更新已关闭或重新打开的草稿。
- `scanToolboxes` 与项目表单使用的 `listToolboxes` 必须来自同一后端工具箱来源；扫描/刷新后，后续新建项目看到同一列表。环境中只保存每个工具箱的运行环境路径，不拆 Python、求解器等字段。
- `pickCliExecutable`、`pickToolboxEnvironment` 的取消是显式 `cancelled`，不视为错误；检测失败/服务测试失败是明确 `error`，不得退化为成功。
- 保存 CLI 路径、当前服务、模式、服务列表和工具箱环境后才算全局配置生效；CLI 实际连接、ChatGPT 登录/退出和检测状态属于外部实际状态，取消草稿不回滚已完成的外部操作。

前端责任：

- 欢迎页、项目表单、离开确认、树菜单、删除确认、标签关闭确认、依赖设置弹窗。
- 校验项目动作是否可执行、防止重复提交、展示加载/取消/失败/重试状态。
- 按 `projectId` 调用能力，维护每个项目的内存会话。
- 只在目标项目真正打开/创建成功后提交切换；离开失败时保留旧项目和未保存内容。
- 关闭项目只结束当前 UI 会话并返回欢迎页，不删除项目文件或已保存记录。

后端接入时必须保证：

- `ProjectInfo.id` 在会话期间稳定，`pathKey` 是跨平台的路径比较键。
- 打开项目先由系统选择文件夹，再返回 `project` 与完整 `tree`；新建项目直接初始化到所选文件夹本身，不再增加一层目录。
- 文件标签使用后端返回的规范化 `fileIdentity`，而不是文件名。重命名、移动文件后同一身份仍有效。
- 目录操作成功时返回完整 `tree` 以及 `changes`。本步前端用 `changes` 判断被删除的标签，并用新树同步标签名称和路径。
- 保存写入由 `saveFile` 完成；停止任务由 `stopTask` 完成；复制路径和显示路径由 `copyText`、`revealPath` 完成。
- 图片字节、MIME、真实解码前的文件定位，以及 Markdown 相对图片的路径解析、权限和范围校验由后端提供。前端只将返回字节形成显示 Blob URL，不依赖真实磁盘路径或传输方式。
- HTML 预览入口负责提供网页及其相对 CSS、脚本、图片和数据资源；入口必须按 `projectId + fileIdentity` 授权，支持释放句柄，并保持在隔离 iframe 中运行。
- H5 后端负责真实 HDF5 解析、类型判断、维度校验、范围切片和无损值序列化；前端不安装 HDF5 解析器，也不把数值转成 JavaScript `Number` 后回写。
- 最近项目和最近时间由后端提供；本步只在内存中更新当前会话。
- 依赖设置后端负责真实 CLI/模型/工具箱操作、密钥安全保存、实际状态订阅和全局配置持久化；CLI 路径、服务地址或环境路径合法不等于连接/模型/环境可用。
- 设置保存必须返回确认后的快照，并承担运行中任务对服务/CLI/环境切换的限制；前端只显示能力接口返回的受限错误。

桌面宿主已在启动桥成功后向 `App` 注入真实的项目/文件/查看器 `ChatFgmCapabilities`（文本、Markdown、图片、CSV、HTML、H5）、工作区、依赖设置、Agent 对话和文件同步能力；`chat`、`settings` 仍以可选属性形式存在，未注入时明确显示未接入。浏览器正式入口不会访问业务后端、Electron 或系统 API。测试适配器中的文本、CSV 解析、H5 结构化数据、HTML 资源、图片、依赖设置、审批和保存结果只用于前端验收；真实桌面测试通过 `test/desktop/` 验证真实写盘、HDF5/HTML 资源服务、图片字节、对话、设置和文件同步。

## 项目管理流程

### 新建项目

1. 欢迎页“新建项目”和顶栏菜单“新建项目”复用同一表单。
2. 工具箱类型来自 `listToolboxes`，不在组件中硬编码；无可用工具箱时显示对应空状态并禁用浏览/创建。
3. 文件夹通过 `pickProjectFolder('create')` 选择；表单不单独要求项目名称，名称沿用文件夹名。
4. 创建请求直接传入该文件夹本身。表单显示“standardCase 将直接在其中初始化”的说明。
5. 当前已打开项目时，先弹出“离开当前项目”确认；只有目标项目创建成功后，才切换并丢弃旧项目未保存内容。
6. 创建失败时保留当前项目和表单输入，并允许重试。

### 打开项目

1. 先调用文件夹选择器；取消或选择器错误不会弹出离开确认，也不会改变当前项目。
2. 选中的路径与当前项目相同则不重新初始化，工作区状态保持不变。
3. 选中其他项目时再弹出离开确认；离开失败时保留旧项目和旧草稿。
4. 欢迎页最近项目直接调用 `openProject`；有当前项目时同样先离开确认。
5. 打开成功后才更新当前项目、项目区间缓存和最近项目。

### 关闭项目

关闭当前项目会回到欢迎页，保留最近项目记录和磁盘文件，不删除内容。存在未保存文件或运行任务时，先经过离开确认。

### 离开确认

- 无未保存文件、无运行任务：取消 / 继续。
- 有未保存文件：取消 / 不保存并继续 / 保存并继续。
- 有运行任务：任务不会被自动中断；需要等待自然结束或成功停止后才能继续。
- 保存失败、停止失败或打开/创建失败时，弹窗保持并展示错误，可重试或取消。
- 任务状态在弹窗打开期间每 500ms 同步；自然完成只解除按钮禁用，不会自动离开。
- 保存动作完成前、停止动作完成前、打开/创建动作完成前，弹窗按钮保持忙碌禁用。
- 丢弃旧项目未保存内容只在目标项目成功打开/创建后提交。

### 项目会话

`app/state/app.ts` 按 `projectId` 维护 `ProjectSession`。每个会话独立保存：

- 项目信息与目录树。
- 目录展开状态和选中项。
- 打开的文件标签、活动标签、文件内容和已保存内容。
- 文本选区与滚动、Markdown 显示模式与预览滚动、图片缩放/适应/平移状态。
- 剪切/复制上下文。

切换项目只改变 `currentProjectId`，不清空旧会话。再次打开时恢复该会话。当前阶段为内存状态，刷新页面会丢失。

## 目录树

`app/features/file-tree/ProjectTree.tsx` 使用能力接口返回的树数据，不硬编码阶段目录。

### 菜单行为

- 根空白区域：新建文件、新建文件夹、粘贴、复制项目路径、在资源管理器中打开。
- 文件夹：新建文件、新建文件夹、添加到对话、剪切、复制、粘贴、重命名、删除、复制路径、在资源管理器中显示。
- 文件：打开、添加到对话、剪切、复制、重命名、删除、复制路径、在资源管理器中显示。
- 菜单支持点击、方向键/Home/End、Esc、外部点击和视口边缘修正。对话能力未接入、当前没有活动对话或对话未就绪时，“添加到对话”禁用；可用时把文件/文件夹引用加入当前对话。
- 重命名、删除、复制路径、显示路径等操作完成后焦点回到对应行。

### 操作规则

- 单击选中，双击文件打开，双击文件夹或点击箭头展开/折叠。
- 支持 `Enter`、`←`、`→`、`↑`、`↓`、`Home`、`End`、`F2`、`Delete`、`Shift+F10` 和 `Ctrl/Cmd+C/X/V`。
- 新建/重命名使用行内输入；空名、非法字符和同级重名先在前端提示，后端仍做最终校验。
- 粘贴前检查目标不是源自身或源的后代；失败时保留剪切/复制上下文。
- 同一项目同一时间只允许一个粘贴请求。等待期间快捷键和右键菜单不能再次提交，菜单“粘贴”显示为禁用；等待状态保存在项目会话中，切换项目后不会丢失或串到另一项目。
- 粘贴成功、失败、取消或异常后都会结束等待状态；失败保留剪贴板并允许重试。
- 删除文件夹会提示其中未保存文件的标签将一并关闭；删除成功后才更新目录和标签。
- 剪切成功后清除剪贴板；复制成功后保留剪贴板。
- 不包含拖拽排序、搜索、筛选或系统文件拖入。

## 文件标签

`app/features/workspace/WorkspaceTabs.tsx` 承载标签和会话状态，并按文件扩展名选择正式查看器。正式构建不包含测试渲染器；测试渲染器只通过第 2 步预览入口注入。所有已打开标签的正式查看器保持挂载但隐藏，以隔离各文件的编辑/撤销、选区和查看状态。

- 标签身份使用 `fileIdentity`，同一文件重复打开只激活已有标签。
- 不同目录下的同名文件可分别打开，标题相同、路径和内容独立。
- 编辑时更新当前标签内容并与已保存内容比较，显示 5px 脏点。
- 关闭干净标签直接移除；关闭脏标签弹出“关闭文件”确认。
- 保存失败时保留标签、内容和脏状态，可重试；保存成功后才关闭。
- 不保存并关闭只关闭工作区标签，不写入文件。
- 关闭活动标签后按右侧优先、再到左侧的规则选择相邻标签；无标签时回到空工作区。
- 标签栏使用横向滚动和左右滚动按钮；标签数量多时保持活动标签可见。
- 标签支持左右方向键切换并同步焦点。

## 正式查看器

### 文本与代码

- `.md/.markdown` 走 Markdown 查看器，`.csv`、`.html/.htm`、`.h5/.hdf5` 走对应只读查看器，常见图片扩展走图片查看器，其余当前文件走文本与代码查看器。
- 编辑器包含行号、语法高亮、透明输入层和同步滚动；使用项目现有等宽字体、12.5px 字号和 20px 行高。长行只在编辑器内部横向滚动。
- 使用 `highlight.js` 注册 Python、JavaScript、TypeScript、JSON、YAML、Bash、PowerShell、C/C++、Java、Go、Rust、CSS、XML、Markdown、SQL、INI、LaTeX 等常见语言；未知语言或高亮异常退化为转义后的普通文本。
- 中文输入、原生选中、复制粘贴、撤销/重做使用浏览器 textarea 能力；每个标签拥有独立 textarea，不共享撤销栈。
- `Ctrl/Cmd+S` 只保存当前项目的活动可编辑文档；模态弹窗存在时不保存后台文档；CSV、HTML、H5 和图片不提交文本保存。
- 文本选区、水平/垂直滚动按项目 + `fileIdentity` 保存在会话中，切换标签或项目后恢复。

### 保存

- 手动保存、关闭标签保存、离开项目保存共用同一个按文件串行/去重的保存入口。
- 每次保存提交内容快照；成功后已保存内容更新为该快照，等待期间的新编辑仍保持未保存。
- 同一文件等待期间相同快照只提交一次；不同快照顺序排队。失败或取消保留内容和脏状态。
- 保存结果携带文档实例标识；关闭后重新打开的新实例不会被旧结果更新。
- 若当前项目存在因扩展名变化而暂时以只读类型（图片/CSV/HTML/H5）打开的未保存文本，离开保存会在弹窗中说明原因并阻止继续，既不写入错误格式也不清除脏状态；用户可取消、改回文本扩展名后保存，或明确选择“不保存并继续”。新建、打开和关闭项目共用此保护。

### Markdown

- 默认白纸式阅读预览，标题栏提供原型已有的“预览/源码”切换；每个文档独立保存模式、源码选区/滚动和预览滚动位置。
- 源码模式复用正式文本编辑器，可编辑并保存；预览始终读取当前内存内容，包括未保存修改。
- 使用 `marked` 解析 GFM（标题、段落、列表、引用、表格、代码块、链接），使用 `katex` 渲染行内和块级公式，使用 `highlight.js` 高亮代码块。
- 使用 `dompurify` 净化 Markdown 生成的 HTML；脚本和事件属性不会执行。KaTeX 以 `trust: false` 渲染。
- 公式识别跳过单反引号、多反引号行内代码以及反引号/波浪号围栏代码；代码内容保持字面量并继续参与原有代码高亮。
- 表格包裹自身横向滚动容器，代码块自身横向滚动，长内容不撑宽整页。
- Markdown 本地图片通过 `readBinaryResource`（文档 `fileIdentity` + 原始相对路径）读取，形成 Blob URL 后放入 `<img>`；缺失或损坏资源显示文档内失败占位。
- 文档重命名或移动后按新的文档位置重新解析本地图片，旧缓存和旧在途结果失效；旧显示 URL 被撤销，新结果显示后替换。
- 关闭文档、内容移除图片或组件卸载时撤销对应 Blob URL。
- `marked`、`dompurify`、`katex`、`highlight.js` 均由应用依赖携带，不新增用户配置项。

### 图片

- 保持比例显示，头部沿用原型控件：缩小、缩放百分比、放大、适应窗口；支持滚轮缩放和鼠标拖动平移。
- 图片使用 `readBinaryResource` 返回的真实字节与 MIME，经 Blob URL 由 `<img>` 解码；SVG 同样作为图片资源显示，不内联为 HTML/SVG 文档。
- 支持 PNG、JPEG、GIF、WebP、BMP、SVG 等原型常见图片格式；未知/无法解码格式显示错误。
- 加载中、读取失败和无法解码使用现有弱化文字/失败色语言展示，不进入文本保存或脏状态。
- 每张图片独立保存 fit/manual 模式、缩放比例、滚动平移位置。fit 模式随面板尺寸变化重新计算；manual 模式不会被普通重渲染重置。
- 关闭标签、删除文件、切换显示类型或应用卸载时撤销显示 URL。切换项目会按当前会话状态重建资源并恢复查看状态。

### CSV

- 复用 `readFile` 文本读取，由前端按 RFC 4180 风格解析：支持引号字段、双引号转义、字段内逗号/换行、空字段、中文和 CRLF/CR/LF；不裁剪字段，不转换数字/日期/布尔，不执行公式。
- 首个数据行保持普通数据，不生成业务表头。数据行数和列数按实际解析结果统计，表头上方显示“行 · 列”。
- 使用 Excel 式只读网格：列字母、行号、选中单元格内框、顶部位置和原始值栏、方向键/Home/End/PageUp/PageDown、Ctrl+C、列宽拖动和内部横纵滚动。
- 视区外用于铺满的空白行列使用独立 `csv-filler` 节点，不参与数据计数、选择或复制。
- 空文件、合法空字段、未闭合引号、引用字段结束后出现非法后缀、未引用字段中出现引号等格式错误分别显示明确状态；错误时不生成伪造网格，也不裁剪或拼接成看似合法的字段。
- 每个文件保存选中单元格、真实列宽和滚动位置，切换标签或项目后恢复；只读操作不产生脏标记。

### HTML

- 通过 `getHtmlPreviewUrl` 获取后端控制的预览入口，在 `sandbox="allow-scripts allow-forms"`（不含 `allow-same-origin`）的 iframe 中加载，不在工作台 DOM 注入网页，不使用 Markdown 净化流程或 `srcdoc` 证明完成。
- 网页保留自身 CSS、脚本、表单、选择器、图片和内部滚动；iframe 的不透明源使其无法读取工作台 DOM、应用状态和能力对象。
- 头部只有原型已有的刷新按钮。刷新中禁用重复提交；刷新失败或取消保留已有页面、输入和脚本状态，并显示错误通知。
- 只有刷新成功提交后才递增 `previewRevision`，iframe 以该代次参与 key：即使后端返回同一个 URL，也会建立新的网页实例并重新执行页面；重渲染、切换标签和项目不改变代次，因此保留原实例。
- 成功替换后优先使用新入口；旧 `handle` 只在确实不再被新入口使用时释放，相同句柄不会在替换瞬间被误释放。关闭、删除、类型切换或应用卸载仍会释放当前句柄。
- 预览入口获取中、获取失败、取消和重试都有明确状态；初始失败保留标签，用户可通过刷新按钮重试。
- 已打开 HTML 页面的 iframe 由 App 根部的持久宿主管理，以项目 + 文档实例为键保留；标签切换只改显隐，不重建；项目切换保留实例并在返回时重新定位。
- 文档移动后不自动重载，下一次主动刷新按新 `fileIdentity` 重新获取入口；内容、标签和实例不因移动重建。
- 关闭标签、删除文档、切换回非 HTML 类型或应用卸载时移除实例；后端若返回 `handle`，由 `releaseHtmlPreview` 释放，静态 URL 不建立额外资源层。

### H5

- 通过 `listH5Datasets` 获取完整路径、dtype、shape、kind、支持情况及原因；数据集以完整路径为身份，同一叶子名的不同路径可区分。
- 工具栏保留原型的“数据集”选择、类型/尺寸信息和文件来源；无数据集、空数组、加载失败和不支持类型分别显示明确提示。
- 支持标量、一维和二维的基础数值、布尔和字符串数据；三维及以上数组、compound/reference 等不支持类型显示原因，不猜测展开。
- 只读网格复用 CSV 的列标题、行号、选择、复制、列宽和内部滚动样式。标量显示 1×1，一维按 N×1，二维按 shape 显示。
- `readH5DatasetRange` 以 `start` + `shape` 请求数据集范围。查看器按可视区域和有限预读计算窗口：单次请求最多 80 行 × 24 列（一维至多 80 个元素），小数据集可在同一窗口内一次覆盖；不会无条件按完整 shape 读取超大数组。
- 当按块对齐和预取得到的窗口不能覆盖当前可见区域时，窗口起点会向可见区域移动，优先选择仍位于可见起点之前且能覆盖视口的块边界；没有合适边界时使用覆盖可见区域所需的最小起点。行、列使用同一逻辑，禁止直接跳到数据集首尾。
- 网格使用虚拟滚动：完整的行数/列数只生成画布尺寸和滚动条，表格 DOM 只绘制当前可视窗口（最多 80 行 × 24 列），并通过返回范围的 `start`/`shape` 把全局行列坐标映射到窗口数据。纵向/横向滚动和键盘跳转会加载新窗口，首尾范围会裁剪到数据集边界。
- 范围缓存按数据集保留当前窗口，新的滚动窗口替换旧窗口，不在滚动过程中无界累积；同一路径的同一窗口请求去重，快速滚动/切换时只允许最新归属的窗口更新视图。
- 每个单元格的 `raw` 是精度安全的原文，`display` 仅用于网格显示；原值栏与 Ctrl+C 始终使用 `raw`，因此 64 位整数不经过 JavaScript Number 转换。
- 每个文件保存当前数据集；每个数据集分别保存选中单元格、列宽和滚动位置，切换数据集、标签或项目后恢复。选中格的缓存以“数据集 + 全局行列”为键；切换到尚未加载的新坐标时会先清空原值，窗口返回后才可复制，避免复制上一窗口或上一数据集的值。
- 数据集列表和范围读取有加载、失败、取消、重试状态；窗口加载期间显示当前区域加载提示，失败显示错误和重试，未加载单元格不以空值冒充。快速切换、延迟返回、关闭/重开和项目切换均用实例/路径/窗口归属保护，旧结果不覆盖当前视图。

### Agent 对话

- 对话能力是 `capabilities` 上的可选组 `chat`；正式入口未注入时，右侧显示“对话能力尚未接入”，新建/历史/发送不可用，不生成默认模型或模拟回复。
- 能力组为：`getContext`、`listConversations`、`loadConversation`、`createConversation`、`saveConversationState`、`selectAttachment`、`releaseAttachmentPreview?`、`sendMessage`、`stopRun`、`subscribeUpdates`。所有结果复用 `ServiceResult`；`subscribeUpdates` 返回取消函数。
- `getContext` 返回当前服务、连接状态、可用模型、默认模型、权限和输入能力。模型列表、默认值和可用性完全动态；正式源码不内置模型名、厂商判断或固定强度档位。
- 每个模型提供 `serviceId`、`modelId`、显示名、可用性/原因、`efforts`（或不支持）、默认强度和文本/图片/文件/项目引用能力。前端只使用这些有效能力，不推断。
- 对话绑定创建时的 `serviceId` 和 `serviceName`。依赖设置保存成功后的全局服务变化只刷新当前能力上下文，不重绑已有对话；不匹配时保留消息、草稿和设置，禁用发送并说明原因。新建对话使用保存后的当前服务。取消设置或保存失败不刷新上下文。前端不复制历史或偷偷创建替代会话。
- 同一对话可以逐轮切换模型。新模型使用自身默认强度；不支持强度的模型将强度设为空并禁用控件。原模型不可用时保留其选择并提示，不静默替换。当前选择只影响下一轮，已提交运行保存实际服务/模型/强度/权限快照。
- 每个项目维护独立对话集合、当前对话、历史摘要、创建状态和错误。每个对话独立保存消息、草稿、引用、模型/强度/权限、运行、展开状态和阅读位置；切换对话、隐藏面板、项目 A → B → A 不串用。
- 历史摘要显示标题、更新时间、执行状态和草稿标记；点击才加载对应详情。加载中/失败/重试有明确状态，迟到加载只更新自己的对话，不改变当前活动对话。
- 消息统一为 `{ role, text, format: 'text' | 'markdown', order, revision, references?, runId? }`。Markdown 复用正式查看器的 `marked + DOMPurify + KaTeX` 管线和安全净化；表格、代码、公式在对话区内部滚动。
- 用户消息使用浅色气泡；Agent 正文不带卡片式任务转换。只有运行层提供 `tools` 或 `steps` 时显示可展开的工具/步骤信息；不从正文编号、标题或关键词推断任务。普通问答不保留伪造执行摘要。
- 运行状态固定为 `running | completed | failed | stopped | unknown`。`unknown` 阻止发送新消息，但不会被当作结束或仍在运行；只有运行层更新后才结束等待。工具名称/摘要/详情按数据通用展示。
- 输入器保留原型结构：添加、权限、模型、强度、发送/停止。Enter 发送，Shift+Enter 换行，组合输入期间不发送；只允许附件或引用单独发送；无内容、连接不可用、服务不匹配、模型不可用、输入类型不兼容时禁用发送并显示原因，草稿保留。待核实重试同样受服务绑定限制：按钮、Enter、`requestChatSend` 和异步核实结束后的实际调用前都会再次核对当前服务与对话绑定服务；不一致时保留原提交和新草稿，切回原服务后可继续。已在切换前发出的请求，其迟到回执仍归并到原项目/对话。
- 发送使用唯一提交标识，前端锁和测试适配器双重防重复。`ChatSendResult` 的结构化错误用 `acceptance: 'not-sent' | 'unknown'` 区分“明确未接收”和“接收结果未知”；未提供该字段的旧错误按明确未接收兼容处理。明确失败/取消保留草稿并允许新的提交。
- 接收结果未知时保存完整的 `pendingSubmission`（原 `submissionId`、正文、引用、服务/模型/强度/权限快照），不会生成新的提交。前端先用 `loadConversation` 核实：快照中存在相同 `submissionId` 的运行才归并并清除待核实状态；快照暂时没有该提交不视为未接收。自动核实失败时，再次点击发送复用原标识和原快照，并依赖服务端按提交标识幂等去重；不会把当前新草稿当作原提交重发。已接收的迟到回执/快照按消息和运行版本归并，不重复添加，也不清除核实期间新输入的草稿。
- 重试本身未发送（包括普通错误、`not-sent`、取消或异常）只说明本次尝试失败，不能证明原提交未接受；原 `pendingSubmission` 及其快照继续保留，下一轮核实/重试仍复用同一标识。只有找到原运行或收到有效接收回执才解除待核实。
- 同一对话只允许一个未解决运行；不同对话可独立运行。发送请求等待属于前端操作状态，与运行终态分开。停止请求成功只表示已受理，界面保持“正在停止”，直到运行更新为终态；停止失败保留运行并提示。
- 项目目录“添加到对话”对文件和文件夹启用，使用 `fileIdentity`/稳定目录 ID 去重。草稿引用和已发送消息引用都保留身份、显示元数据和快照；树重命名/移动同步显示，删除标记失效。附件由 `selectAttachment` 注入，临时预览 token 在不再被任何草稿或消息使用时释放。
- 附件选择按发起时的对话归属，切换对话不会写入新对话；目标模型不支持附件类型时保留引用并禁止发送。
- 对话更新通过 `subscribeUpdates` 的 `context | conversation | snapshot | message | run` 事件进入；消息按 ID/revision/order 去重，运行按 revision 合并并禁止终态回退到 running。连接订阅随打开项目建立，对话切换不重建，关闭项目和应用卸载时清理；StrictMode 下不重复订阅。
- 快照合并始终先按记录身份/revision 合并消息和运行，再更新摘要；`hasLoadedState` 独立于当前 `loading` 状态，已经获得过本地状态的对话在刷新时保留草稿、引用、下一轮设置和阅读位置。旧快照不能删除实时运行、回退消息或终结状态，也不能选择其他对话。初次加载期间先到的运行/消息与迟到的旧快照同时保留。
- 连接恢复时记录前一次连接状态；只在从非 connected 转为 connected 时同步。同步只针对当前项目中没有结束的运行（含后台对话），强制重新加载这些对话，补齐断线期间的消息和终态；仍运行的保持 running，unknown 保持待核实。同步期间重复 connected 事件不重复请求；失败显示可恢复提示并保留本地内容；结果写回发起时的项目，不切换当前对话/项目；恢复快照不补发后台完成通知。
- 重连同步保持每个项目单次在途请求，并用项目级代次记录同步期间的新一次重连。首次在途核实结束后，若代次已推进，则再发起一次新的详情加载，获取覆盖最新连接代次的快照，而不是复用旧请求；普通重复 connected 不推进代次。后续核实仍写回原项目/对话；切换项目后以背景归属方式更新原项目，不激活或重置当前界面。
- 草稿、设置、引用和阅读位置通过 `saveConversationState` 保存；输入后短暂防抖，切换对话/项目时冲刷。保存携带独立 `stateRevision`，队列执行时读取最新本地状态；冲突只提示并重新加载版本，不丢内存内容，也不覆盖正在编辑的草稿。服务端确认接收时会按内容相等条件清除已发送草稿，迟到的旧保存不会写回。
- 项目活动对话通过 `getProjectState` / `setActiveConversation` 恢复并保存；对话快照同时携带 `stateRevision`、`historyStatus` 和可选 `pendingSubmission`。历史核实时无法确认的内容明确显示提示，不伪造缺失消息。
- 后台通知只在当前项目中任务所属对话不可见（其他对话或右面板隐藏）且收到完成/失败/停止终态时出现；开始、进度、历史加载、重复终态和事后切换不补发。通知位于中央工作区底部，显示对话、结果和“查看”，普通通知约 4 秒、后台任务通知约 7 秒；模态弹窗期间“查看”禁用。点击查看展开右面板、定位对话并清除提醒；关闭项目切换项目时清除提醒。
- 通知状态记录与运行 reducer 共用 `isAcceptedRunUpdate`：只有被版本/终态规则接受的运行变化才能把记录从非终态推进到终态。旧 revision running、重复终态、迟到发送回执和旧快照都不能回退记录；已经查看/清除/超时的终态不会因重放再次提醒，新的运行仍会正常通知。
- 离开项目的运行任务查询复用 `listRunningTasks`，停止复用 `stopTask`，测试适配器会把全部对话的运行记录加入任务列表。停止请求后界面继续轮询，只有任务列表确认没有任务时才解锁继续；查询失败/状态未知不视为无任务。自然结束只解锁按钮，不自动离开。

### 审批、工具箱与外部文件变化

- 运行层产生审批请求时，现有运行轨迹显示“等待审批”，对话区显示“等待审批 · N 个请求”和“查看审批”。后台请求不切换对话、不抢焦点。
- 审批弹窗复用现有 Modal 风格，显示所属对话、操作类型、命令/路径、工作目录和原因；提供“批准本次”“拒绝”“暂不处理”。关闭、遮罩或 Esc 只暂不处理，不隐含批准或拒绝；停止仍使用对话区停止按钮。
- 多个待审批请求分别保留身份，可在弹窗内切换；已决定/失效的请求不再可答复。前端只发送不透明审批 id 和 `approve|deny`，不能提交修改后的命令或路径。
- 未绑定工具箱的项目显示简洁提示和“选择工具箱”入口；选择弹窗列出扫描结果，损坏工具箱显示具体原因并禁用。绑定只保存类型，不初始化 `standardCase`、不覆盖文件；已绑定项目本期不提供换型入口。
- 后端上报的外部文件变化只更新已打开项目会话：不重新打开项目、不改变最近打开时间和活动标签。新文件进入目录树但不自动打开。
- 干净文本/Markdown/CSV 重新读取并保留选区/滚动等状态；未保存文本保留内容和撤销状态，不自动覆盖。
- 图片/H5 重新读取数据并尽量保留缩放/选择；HTML 保留页面实例和内部状态，提示“文件已更新”，由原刷新按钮加载。
- 保存冲突弹窗提供“取消并保留编辑”“重新载入磁盘”“覆盖保存”；覆盖前由后端再次校验磁盘版本，确认期间再次变化会重新冲突。保存失败仍保留内容与脏状态。
- 文件删除后，脏标签保留并显示“另存为”；另存写项目根目录的新文件，不覆盖已有文件。

## 依赖设置

### 入口与弹窗

- 顶栏设置按钮仅在注入 `capabilities.settings` 时启用；欢迎页和工作台都可打开同一个全局弹窗。第 5 步正式桌面入口已注入真实设置能力；普通浏览器/测试预览仍没有该能力时按钮禁用且不显示样例内容。
- 弹窗 900px 宽、最高 660px，左侧三类导航，右侧内容滚动，底部取消/保存。窄窗口下缩至 `calc(100vw - 32px)`，高度随视口收缩；800/1000/1440 均无横向溢出。
- 打开时从 `getSnapshot` 加载；加载失败显示错误和重试，不展示默认/样例配置。加载、保存、检测、测试和授权等待期间避免重复请求，保存中锁定内容和重复提交。
- 取消丢弃配置草稿并关闭，不更新已保存配置；取消未完成检测/授权请求或等待其结果，但不回滚已完成的外部登录/退出/实际连接状态。关闭后焦点回到设置按钮。
- 设置弹窗打开期间项目操作和后台通知“查看”不可操作；后台任务和通知状态仍可更新，关闭弹窗后恢复。新服务取消确认是嵌套紧凑弹窗，关闭它不会关闭设置本身。

### Codex CLI

- 程序路径可手输或通过 `pickCliExecutable` 浏览；取消选择保留原值，选择错误就地提示。
- “检测并连接”调用 `detectCli`，等待时禁用重复检测；成功显示后端版本/说明，失败显示错误并允许重试。
- 修改路径立即使旧检测结果失效。保存只写路径；实际连接状态由 `runtime.cli` 单独提供，不能由路径或检测结果的旧副本推断。状态栏优先显示该实际 CLI 状态（加载前才回退对话上下文）。
- 设置打开期间收到 `runtime.cli` 更新时，仅当实际状态的路径匹配当前草稿路径（运行时未提供路径时回退到已保存路径）才更新现有检测结果区域；状态、版本和说明全部来自该实际结果。同步只更新 CLI 展示，不重建或覆盖路径、服务字段、密钥输入和工具箱环境草稿。
- “实际连接”与“草稿检测结果”共用现有结果区域但内部区分来源和接受时的 runtime revision：实际状态更新会推进请求令牌，使迟到的本地检测回调不能覆盖；草稿路径与旧路径不匹配时旧实际状态不显示。修改路径仍清零本地结果；重新匹配时只接受匹配的新实际结果。
- 设置页和状态栏读取同一 runtime revision 的实际 CLI 状态；检测等待、失败重试和请求归属仍按原规则，不增加轮询或整页重载。

### 模型服务

- ChatGPT 登录/退出直接更新实际账号状态，不写入设置草稿；授权等待时登录/保存禁用，关闭设置会取消未完成授权。失败显示原因并允许重新登录；重新打开读取实际状态，已完成操作不会因取消设置回滚。
- 自定义 API 服务列表有稳定 `id`，编辑名称或地址不改变身份。当前服务是草稿选择，只有保存后才更新全局对话上下文。
- 新增服务先形成草稿；有输入时点“取消添加”弹出放弃确认，空草稿直接移除。保存时有效新增项写入，未完成新增项被忽略并在成功通知中明确列出，不静默保存无效配置。
- 已保存密钥只接收 `hasKey`，不向前端回显。输入框默认密码遮罩，可显示/隐藏当前输入；已保存服务留空表示保留原密钥，输入新值表示替换，空输入不会清空密钥。新增服务必须填写密钥。
- 连接测试把当前名称、地址、密钥操作和已保存密钥语义交给能力接口；只有接口成功才显示连接成功，URL 格式正确不等于服务可用。修改测试过的字段立即清除该服务旧结果；不同服务结果独立，迟到结果不污染当前服务。
- 连接测试的 resolve/reject 使用同一归属判定：弹窗代次、服务身份、请求令牌及当前地址/密钥都必须匹配。输入变化、服务移除、关闭重开后的旧异常不更新结果；请求完成只清理自己的在途/忙碌标记，不误清理其他服务。当前请求的真实异常仍显示失败并允许重试。
- 后端 `runtime.models` 为非 inactive 时，在模型服务面板显示真实“准备中/已就绪/激活失败”状态和说明；配置保存成功但运行层准备失败时，配置仍保留，状态不得伪装成已连接。该状态行只复用现有 `settings-result` 样式，不新增页面。
- 编辑已有服务必填项无效时阻止保存并标记字段；新增服务无效项按未完成草稿处理（丢弃并通知）。保存成功后重新打开从后端快照恢复服务、当前项和“已配置”密钥状态，不恢复测试成功标记。

### Flamelet 工具箱

- 首次进入分类调用 `scanToolboxes`；刷新复用同一能力。加载、失败重试和空列表各有明确状态。扫描结果与新建项目 `listToolboxes` 共用后端来源，刷新后后续新建项目使用新列表。
- 工具箱类型由 `toolboxes/` 下一级文件夹名决定：文件夹名既是稳定类型也是显示名称。没有 `toolbox.json`，也没有 id/label 映射；支持中文、英文和带空格的合法 Windows 文件夹名。新增文件夹后刷新即可发现，不需要修改前端类型列表。
- 单个工具箱缺少 `standardCase`、skills 损坏或被拒绝时，只在该行显示具体原因，不影响其他工具箱。
- 每个工具箱独立保存运行环境路径、选择、检测结果和请求令牌；切换工具箱保留各自草稿。选择取消保留原值，检测失败可重试。
- 修改环境路径立即使该工具箱旧检测结果失效；检测/选择迟到结果只回到发起时的工具箱和路径，不覆盖当前输入。环境检测状态不改变 CLI 状态栏，也不与模型服务成功标记混用。
- 保存只写环境路径，不拆分 Python/求解器配置；保存后重开弹窗恢复路径及路径匹配的实际检测状态。

## 异步归属与并发保护

- 每个异步操作记录其目标项目/弹窗令牌；返回后只在令牌仍有效时更新。
- 项目切换后的延迟文件读取、目录操作结果更新到原项目缓存，不覆盖当前项目。
- 文件读取按“项目 + `fileIdentity`”单飞：同一文件尚在读取时重复打开复用原请求，不并发读取；完成、失败或异常后清理在途记录，可重试。
- 标签关闭会推进对应文件的文档代次。旧读取即使稍后返回，也不能重新打开已关闭标签、覆盖后来打开的标签或显示过期错误；关闭确认取消不算已关闭。
- 关闭并重新打开项目表单后，旧的工具箱加载结果不会覆盖新表单。
- 项目打开/创建、保存、停止任务、目录操作在等待期间禁用重复提交；失败后可重试。
- 保存按项目和文档实例归属；同一快照的去重可跨手动保存/关闭/离开共用，迟到失败不更新已关闭并重新打开的新文档。
- 图片二进制读取在 StrictMode 双重挂载下复用同一个在途请求；关闭标签、切换项目或删除后返回的结果不会创建新标签或显示到当前项目。
- HTML 入口请求按项目、文档实例和请求代次归属；关闭/切换类型后返回的入口会释放句柄，不写入当前视图。刷新失败或取消不清空旧入口，成功提交才递增 iframe 代次并替换页面。
- H5 列表和范围读取按挂载实例、数据集路径和窗口请求令牌归属；旧数据集结果只缓存到自己的路径，快速切换不覆盖当前网格；滚动产生的新窗口替换该数据集旧窗口，不产生无界缓存；关闭/切换项目后旧结果不更新视图。
- 对话上下文按能力实例加载；列表、详情、附件、发送、停止和保存按项目/对话请求去重。迟到的详情只写入原对话；消息和运行更新按 revision 合并，终态不可被旧快照回退。
- 对话订阅只在打开项目期间存在；切换对话保持订阅，关闭项目或 App 卸载取消。StrictMode 的 setup/cleanup 不产生重复监听；测试适配器可检查活动订阅数。
- 设置加载、保存、CLI 浏览/检测、API 测试、授权、工具箱扫描、环境选择/检测都记录弹窗代次和操作令牌；关闭/重新打开后旧回调不更新新草稿。保存按一次在途锁去重；检测/测试/扫描/授权各自避免重复。
- API 测试的 Promise resolve 与 reject 共用服务身份/输入/请求令牌校验；忙碌标记按请求令牌归属清理。CLI 实际状态通过 runtime revision 和匹配路径进入现有结果区域，并推进本地令牌，使已接受的较新实际状态不被迟到检测结果覆盖。
- CLI 路径、服务字段和工具箱环境修改会推进各自令牌并使旧检测/测试结果失效；迟到结果只按工具箱/服务/请求归属更新原对象，不污染当前选择。
- 设置实际状态订阅在 App 能力实例生命周期内唯一，StrictMode cleanup 取消；旧 `getSnapshot` 结果不能回退更新的 runtime revision。保存成功才刷新对话上下文，取消或失败不刷新。
- 后台通知按运行从 running/unknown 到终态的转换生成，历史加载只记录状态不补发；多个终态使用一个简单通知槽替换，不建立通知中心。
- 离开确认中的“不保存”只在目标项目成功打开/创建后执行。
- 保存和停止任务失败时不会提交离开。

## 面板与通用弹窗

- `app/state/layout.ts` 保留第 1 步的面板宽度、显隐、拖拽和响应式约束。
- 普通弹窗默认 480px，可点击遮罩关闭；新建项目 480px、离开确认 440px、关闭标签 480px；依赖设置 900px 宽、最高 660px。
- 紧凑确认弹窗 400px，点击遮罩取消但不自动关闭；未完成服务的放弃确认复用该规则。
- 所有模态弹窗都保留焦点陷阱、背景隔离、初始焦点和关闭后焦点恢复；依赖设置初始聚焦第一个分类，关闭后回到设置按钮；关闭后无可用原触发元素时回到 ChatFGM 菜单按钮。
- 依赖设置打开时与新建项目/离开/关闭标签/通知动作互斥；保存中不允许遮罩、Escape 或取消关闭，其他检测等待期间仍可取消。

## 验收与截图

`npm run test:ui` 在 `test/results/` 生成：

- `screenshots/welcome-1440x900.png`
- `screenshots/welcome-1000x800.png`
- `screenshots/welcome-800x860.png`
- `screenshots/workspace-1440x900.png`
- `screenshots/workspace-1000x800.png`
- `screenshots/workspace-800x860.png`
- `screenshots/welcome-no-capabilities-1440x900.png`
- `screenshots/app-menu-enabled-1440x900.png`
- `screenshots/app-menu-project-1440x900.png`
- `screenshots/menu-disabled-1440x900.png`
- `screenshots/project-form-1440x900.png`
- `screenshots/project-form-800x860.png`
- `screenshots/tree-context-menu-1440x900.png`
- `screenshots/file-tabs-1440x900.png`
- `screenshots/tab-close-unsaved-1440x900.png`
- `screenshots/leave-confirm-1440x900.png`
- `screenshots/leave-confirm-800x860.png`
- `screenshots/tabs-overflow-800x860.png`
- `screenshots/project-session-restored-1440x900.png`
- `screenshots/workspace-restored-800x860.png`
- `screenshots/viewer-code-1440x900.png`
- `screenshots/viewer-code-1000x800.png`
- `screenshots/viewer-code-800x860.png`
- `screenshots/viewer-markdown-1440x900.png`
- `screenshots/viewer-markdown-1000x800.png`
- `screenshots/viewer-markdown-800x860.png`
- `screenshots/viewer-markdown-source-1440x900.png`
- `screenshots/viewer-image-1440x900.png`
- `screenshots/viewer-image-1000x800.png`
- `screenshots/viewer-image-800x860.png`
- `screenshots/viewer-image-error-1440x900.png`
- `screenshots/fix-leave-blocked-1440x900.png`
- `screenshots/fix-leave-blocked-1000x800.png`
- `screenshots/fix-leave-blocked-800x860.png`
- `screenshots/fix-math-code-1440x900.png`
- `screenshots/fix-math-code-1000x800.png`
- `screenshots/fix-math-code-800x860.png`
- `screenshots/fix-markdown-moved-fallback-1440x900.png`
- `screenshots/fix-markdown-moved-fallback-1000x800.png`
- `screenshots/fix-markdown-moved-fallback-800x860.png`
- `screenshots/fix-markdown-moved-valid-1440x900.png`
- `screenshots/step4-csv-1440x900.png`
- `screenshots/step4-csv-1000x800.png`
- `screenshots/step4-csv-800x860.png`
- `screenshots/step4-html-1440x900.png`
- `screenshots/step4-html-1000x800.png`
- `screenshots/step4-html-800x860.png`
- `screenshots/step4-h5-1440x900.png`
- `screenshots/step4-h5-1000x800.png`
- `screenshots/step4-h5-800x860.png`
- `screenshots/step4-h5-window-1440x900.png`
- `screenshots/step5-chat-1440x900.png`
- `screenshots/step5-chat-1000x800.png`
- `screenshots/step5-chat-800x860.png`
- `screenshots/step5-chat-history-1440x900.png`
- `screenshots/step5-chat-history-1000x800.png`
- `screenshots/step5-chat-history-800x860.png`
- `screenshots/step5-chat-trace-1440x900.png`
- `screenshots/step5-chat-composer-menu-1440x900.png`
- `screenshots/step5-chat-model-menu-1440x900.png`
- `screenshots/step5-chat-model-menu-800x860.png`
- `screenshots/step5-chat-notification-1440x900.png`
- `screenshots/step5-chat-notification-800x860.png`
- `screenshots/step5-chat-notification-modal-800x860.png`
- `screenshots/step5-chat-right-hidden-800x860.png`
- `step6/screenshots/settings-cli-1440x900.png`
- `step6/screenshots/settings-cli-1000x800.png`
- `step6/screenshots/settings-cli-800x860.png`
- `step6/screenshots/settings-api-1440x900.png`
- `step6/screenshots/settings-api-1000x800.png`
- `step6/screenshots/settings-api-800x860.png`
- `step6/screenshots/settings-chatgpt-1440x900.png`
- `step6/screenshots/settings-chatgpt-1000x800.png`
- `step6/screenshots/settings-chatgpt-800x860.png`
- `step6/screenshots/settings-toolboxes-1440x900.png`
- `step6/screenshots/settings-toolboxes-1000x800.png`
- `step6/screenshots/settings-toolboxes-800x860.png`
- `step6/screenshots/settings-load-error-1440x900.png`
- `screenshots/step7-approval-800.png`
- `screenshots/step7-approval-1000.png`
- `screenshots/step7-approval-1440.png`
- `step6/screenshots/settings-confirm-new-service-1440x900.png`
- `step6-fixes/screenshots/settings-actual-cli-error-1440x900.png`
- `step6-fixes/screenshots/settings-actual-cli-error-1000x800.png`
- `step6-fixes/screenshots/settings-actual-cli-error-800x860.png`
- `step6-fixes/screenshots/chatgpt-current-service-new-conversation-1440x900.png`
- `step5-fixes/history-active-1440x900.png`
- `step5-fixes/history-active-1000x800.png`
- `step5-fixes/history-active-800x860.png`
- `step5-fixes/status-connecting-1440x900.png`
- `step5-fixes/status-connecting-1000x800.png`
- `step5-fixes/status-connecting-800x860.png`
- `step5-fixes/status-not-connected-1440x900.png`
- `step5-fixes/status-not-connected-1000x800.png`
- `step5-fixes/status-not-connected-800x860.png`
- `step5-fixes/status-error-1440x900.png`
- `step5-fixes/status-error-1000x800.png`
- `step5-fixes/status-error-800x860.png`
- `step5-fixes/prototype-history-connected-1440x900.png`
- `step5-fixes/prototype-reference.md`
- `step5-fixes/before-fix.md`
- `step5-fixes/artifacts-before/`（修复前失败证据）
- `step5-fixes/final/`（最终 typecheck/lint/build/UI 日志）
- `screenshots/step4-csv-error-1440x900.png`
- `screenshots/step4-html-error-1440x900.png`
- `screenshots/step4-h5-unsupported-1440x900.png`
- `screenshots/component-menu-1000x800.png`
- `screenshots/component-confirm-dialog-1440x900.png`
- `screenshots/component-confirm-dialog-1000x800.png`
- `screenshots/component-confirm-dialog-800x860.png`
- `report/index.html`

测试覆盖：

- 正式无能力入口的禁用状态，测试预览的能力注入和最近项目。
- 项目新建/打开/取消/失败/重试、无工具箱、表单保留、重复路径、A → B → A 会话恢复。
- 离开确认的干净状态、未保存、运行任务、两者并存、保存失败、停止失败、任务自然完成、失败重试。
- 目录根/文件夹/文件菜单、键盘菜单、行键盘操作、名称校验、后端失败重试、重命名/删除的标签同步、剪切/复制/粘贴、剪贴板保留、无效目标、复制路径/显示路径。
- 粘贴等待期间重复快捷键、菜单与快捷键混用只产生一次请求；等待菜单禁用、失败重试、剪切/复制模式、切换项目后的归属。
- 标签去重、同名文件、内容脏状态、方向键、相邻标签选择、保存失败重试、丢弃、读取失败、标签溢出滚动。
- 同一文件读取期间重复打开只产生一次读取；关闭后旧结果不重开；读取期间重命名、移动、删除；失败重试。
- 文本/代码行号、高亮、快照保存、保存期间编辑、重复 Ctrl+S、保存失败重试、保存归属、关闭/离开保存。
- 文本选区/滚动跨标签和项目恢复、长行内部滚动、中文输入、复制粘贴、撤销重做及按文件隔离。
- Markdown 标题/列表/引用/表格/代码/链接/公式实际渲染、净化、模式与预览滚动隔离、未保存内容预览、源码保存、本地图片和缺失图片。
- Markdown 移动后按新位置重新解析图片、失效旧缓存/旧 URL/旧在途结果，并在新位置有效或缺失时分别显示新资源或失败占位。
- 公式与单/多反引号行内代码、反引号/波浪号围栏代码隔离，代码外公式仍实际渲染。
- 图片格式解码、加载/缺失/解码失败、缩放/平移/适应窗口、面板 resize、跨标签/项目状态、显示 URL 创建与释放、删除和关闭时清理、图片不改脏不保存。
- 图片/CSV/HTML/H5 扩展名下的未保存文本在关闭、新建、打开离开时均阻止“保存并继续”并给出原因，支持取消恢复、明确丢弃和干净图片正常离开。
- CSV 复杂字段、空文件、空字段、未闭合引号、引用闭合后的非法后缀/非法引号结构、选择/键盘/复制/列宽/滚动及跨项目恢复，首行保持数据且填充网格不参与数据。
- HTML 真实 CSS/脚本/图片/JSON 资源、表单和选择器、隔离安全、跨标签/项目实例保留、同 URL 强制重载、不同 URL 刷新、失败/取消保留、句柄复用、移动后刷新、删除/关闭释放句柄，以及请求尚未返回时关闭标签后释放迟到句柄。
- H5 标量/一维/二维/空/无数据集/不支持类型、完整路径去重、64 位原值、显示与复制分离、按数据集状态、快速切换去重、迟到结果、失败重试和关闭重开；大型 shape 按可视窗口请求，验证首次/滚动后请求上限、非零起点、纵横窗口、一维窗口、边界键盘跳转、DOM 数量上限、失败重试及加载期间不复制旧窗口值。
- H5 在 1440×1200 视口滚动到第 47 行、分块交界、前后滚动、数据集首尾、一维数据集、宽视口横向窗口及 900/1200 高度切换时，断言请求范围覆盖实际渲染区域、全局坐标值正确、加载提示结束；同时验证行、列请求不超过 80×24，避免块对齐窗口不足时跳到数据集末尾。
- 对话：多项目/多对话内容、草稿、设置、引用和阅读状态隔离；同服务模型切换、不同强度选项、不支持强度、原模型失效；全局服务切换不重绑并保留受限草稿；运行设置快照不被当前选择改写。
- 对话消息与运行：Markdown 表格/代码/公式和复制、普通编号列表不生成任务卡片、工具无步骤/步骤无工具/步骤更新、未知运行状态、重复终态不覆盖、停止请求等待最终状态、停止失败保留运行。
- 对话输入与异步：Enter/Shift+Enter、IME 确认、重复发送去重、发送失败/取消/结果不明保留草稿、迟到接收不清空新输入、保存失败保留内存内容、迟到详情不替换当前会话、错误重试。
- 对话附件与引用：文件和文件夹添加、同对象去重、重命名同步、删除失效、延迟附件定位原对话、图片模型兼容、仅附件发送、共享预览 token 生命周期。
- 对话通知与离开：后台任务/普通通知区分、隐藏面板、切换对话、查看定位、模态期间禁用、关闭清除、订阅 StrictMode 数量和关闭清理；多个对话运行任务与未保存文件同时存在时的离开停止等待。
- 第 5 步验收修复：实际已接收但回执/更新丢失时自动加载核实、旧快照无提交不当作未接收、同 submissionId 重试不产生第二次执行、新草稿保留；明确失败/取消仍可新提交；未知结果与明确未接收使用结构化结果区分。
- 快照合并：初次加载期间先收到 running/terminal 再返回请求开始时的旧快照，运行、消息和摘要不回退；已加载对话重连刷新保留草稿、模型强度和当前选择；旧快照不改变活动对话。
- 重连核实：断线事件真实丢弃、completed/failed/stopped 后台运行恢复、仍运行/unknown 保持、重复 connected 去重、同步失败可重试、同步期间切换对话/项目不串结果、恢复不补发通知。
- 重连边界：第一次同步仍挂起时发生第二次断线/重连，首次旧快照返回后必须再加载一次最新快照；多个普通 connected 不重复请求；连续断线后 completed/failed/stopped/仍 running 的控件状态正确；第二次核实期间切换对话/项目仍归属原对话/项目，订阅数不增长。
- 待核实重试边界：重试在到达服务前 not-sent、取消或抛异常时保留原 `submissionId`/输入快照，下一次仍复用同一标识；核实期间新草稿和新设置不被覆盖；只有找到原运行或有效回执才解除。切换服务后按钮/Enter/实际调用均受服务绑定限制，核实挂起期间切换服务也不会发出请求；切换前已发出的迟到结果仍归并原对话。
- 通知去重：真实旧 revision 和重复终态重放不重新提醒，迟到回执/旧快照不激活旧通知，新运行仍正常通知。
- 视觉：历史当前会话 brand-soft/内描边/brand-ink；连接中/未连接/已连接/异常的文字、圆核或异常标记及语义颜色，在 800/1000/1440 计算样式和截图中核对。
- 依赖设置入口：正式无能力禁用、欢迎页/工作台打开、初始焦点、Escape/取消关闭和焦点恢复；900×660 弹窗在 800/1000/1440 无溢出。
- 设置加载失败/重试、关闭后迟到加载隔离；保存失败保留草稿、重试成功关闭、保存等待期间重复提交只发一次且不可关闭；取消丢弃草稿。
- CLI：浏览取消/失败/成功、路径修改使旧结果失效、检测等待去重、成功版本和失败状态、保存后恢复、状态栏实际 CLI 状态与设置独立；服务测试/环境检测失败不影响 CLI 状态。
- 模型服务：草稿取消恢复、稳定服务身份、当前项选择、删除当前项选下一项、已保存密钥不回显/空输入保留/替换语义、密码遮罩与显示隐藏、URL/名称校验、测试结果按服务隔离、迟到测试不覆盖新输入、连接失败重试。
- 新增服务：空草稿直接移除、有内容取消确认/继续/放弃、有效新增保存后恢复、无效新增保存时明确忽略并通知、密钥不进入快照或通知。
- ChatGPT：实际账号登录/退出、取消设置不回滚已完成状态、失败重试、未完成授权取消、关闭后迟到结果不更新重开草稿、授权期间保存禁用。
- 工具箱：首次扫描/刷新/失败重试/空列表、扫描列表与新建项目一致、每个工具箱独立环境、选择取消/成功、环境检测成功/失败重试、路径修改使旧结果失效、迟到环境结果按工具箱和路径隔离、保存后恢复、刷新不覆盖环境草稿。
- 全局生效：保存当前服务刷新对话上下文、已有对话不重绑且保留消息/历史、受限发送说明、新对话使用新服务；取消设置和保存失败不刷新。
- 第 6 步验收修复：设置打开期间同路径 CLI 实际状态 connected → error → connected 同步状态/版本/说明，状态栏一致；草稿路径不同时旧实际状态不显示，切回匹配路径后接受；保存中的服务名和工具箱环境草稿不被状态同步覆盖；实际状态更新后的迟到检测结果不回退。
- 第 7 步：审批等待条与弹窗、多请求身份、批准/拒绝、关闭重开/Esc 暂不处理；未绑定工具箱提示、选择与绑定，且不初始化标准模板；800/1000/1440 审批弹窗可达。
- 第 7 步：外部文件更新同步目录树、干净文本/Markdown/CSV 刷新、脏编辑不被覆盖、图片/H5 重新读取、HTML 保留实例并提示更新并在刷新后清除提示；保存冲突取消/重载/再次冲突/确认覆盖；删除脏文档后的另存为。
- API 测试 Promise reject：地址修改、密钥修改、服务移除、关闭重开后的旧异常不产生旧失败；当前请求真实 reject 显示失败并可重试成功；成功、显式 error、cancelled 和延迟结果仍通过。
- 模式上下文：API → 已登录 ChatGPT 保存后新对话使用 ChatGPT 测试服务；ChatGPT → API 保存后使用所选 API；仅改模式取消不生效；登录后取消保留账号但不切换模式；ChatGPT 模式退出后上下文不可用；API 服务清空后返回 `settings-api-unavailable` 且不暴露旧服务。
- 已有对话在模式保存后保留内容、草稿、引用、模型强度和运行中任务的提交快照，不自动停止或改写。
- 后台通知在设置打开期间不可操作、后台任务仍更新，关闭设置后恢复；设置嵌套确认关闭不影响设置本身。
- 延迟结果归属、旧工具箱回调隔离、面板拖拽收尾、紧凑弹窗规则、模态焦点与背景隔离、页面无未处理异常和横向溢出。

## 图形资源与设计基线

- 设计基线：`references/UI原型/index.html` 与 `references/UI原型/DESIGN.md`。
- 顶栏、面板标题、菜单、状态栏、按钮、弹窗、目录树和标签的尺寸、颜色、间距、字体按原型最终样式实现。
- 对话历史当前会话使用 `--brand-soft` 背景、`--brand-line` 内描边和 `--brand-ink` 标题；hover 使用 `--brand-soft-2`。
- 状态栏连接中为 `--text-muted`，已连接文字/圆核为 `--success`/`--success-dot`，连接异常为 `--danger` 并显示异常标记，未连接保持中性；控件尺寸和布局不变。
- 设置弹窗沿用原型的 900px 宽、最高 660px、左侧分类/右侧内容/底部操作结构、服务与工具箱行式列表、检测结果徽标和密码遮罩；原型中的演示路径、演示账号、定时假成功和“示例演示”说明没有迁移。正式设置文案改为真实能力语义，设置按钮在欢迎页/工作台均可用。
- 原型中的演示数据、演示说明和对话模拟逻辑没有迁移到正式页面。
- 本步新增图标（文件夹、文件、箭头、关闭、滚动、图片缩放、HTML 刷新）沿用原型的 SVG 路径。
- Markdown、公式、净化与高亮依赖由应用携带：`marked`、`dompurify`、`katex`、`highlight.js`。它们随构建产物发布，不需要用户设置。

## 已知限制

- 正式桌面入口已接入真实后端磁盘、编码检测、权限和写盘；测试能力适配器仍仅用于浏览器前端回归。
- 启动始终显示欢迎页，不自动打开上次项目；打开项目后才从数据库恢复该项目布局/标签/查看器状态。同一进程内的内存会话优先于数据库快照。
- 切换项目会卸载再重建项目视图；图片字节会重新读取，但 fit/manual、缩放和平移状态从会话/快照恢复。HTML 页面实例例外，由 App 根部持久宿主保留；应用重启只恢复 HTML 标签并重新申请预览入口。
- 自动工作区快照只写应用数据库；恢复副本不是已保存文件。保存并退出/保存并继续才会写项目文件。
- 文本文件临时改为只读扩展名时保留隐藏的未保存文本，但只读模式下不允许文本保存；离开保存会被明确阻止，取消并改回文本扩展名后内容与脏状态恢复。只读类型改为文本/CSV 时通过 `readFile` 补水文本内容。
- Markdown 本地图片的路径解析和范围校验完全依赖后端；前端只传文档身份和作者书写的相对路径。文档移动后的重新解析仍遵循这一边界。
- 前端测试的 HTML 预览仍由 `test/html-fixtures/` 的测试静态中间件提供；正式桌面入口由后端 `chatfgm-preview://` 提供受权限控制的入口和资源服务。网页自身资源加载失败由网页呈现，工作台只处理入口失败。
- H5 的范围窗口由前端按固定上限（80 行 × 24 列）和可视区域计算；真实 HDF5 解析、元信息、维度校验、HDF5 层切片、无损序列化和资源限制由后端 worker 承担。当前只缓存每个数据集最近一个窗口，返回旧数据集时可能需要重新请求，这是有意的内存控制。
- H5 窗口请求返回的 `start`/`shape` 必须覆盖所请求的范围；前端会使用返回的实际起点映射全局坐标，范围不足、维度不符或值矩阵不完整会按错误显示，不填充伪造值。
- HTML 页面内的 CSS/JS/数据资源加载失败由网页自身呈现，工作台只处理预览入口失败。
- 测试中的项目创建、保存等待和 HTML 加载状态使用测试适配器的显式挂起/放行控制；正式应用没有测试开关、延迟或控制桥。
- 对话能力已由正式桌面入口注入真实后端：app-server、原 thread 续聊、真实执行、审批、停止、附件/截图和持久化。测试预览中的消息、工具、步骤、运行、审批和附件仍由 `test/` 内存适配器生成。
- 审批弹窗、工具箱选择、文件冲突和另存为复用现有 Modal/按钮/通知样式；新增的“等待审批”“查看审批”“选择工具箱”“文件已更新”“另存为”只出现在既有执行/对话/查看器区域。
- 工具箱扫描结果与新建项目的同源依赖后端 `scanToolboxes`/`listToolboxes` 一致；正式后端按文件夹名扫描并原位加载，测试适配器使用内存列表和内存项目更新事件验证前端行为。
- 测试预览中的对话草稿、设置和阅读位置“保存”只写入测试内存；测试预览的应用刷新/重启恢复不纳入本阶段。正式桌面入口的对话草稿、消息/运行状态、设置和阅读位置由后端持久化，重启后按后端快照恢复；跨服务迁移和历史搬运仍不在本阶段。关闭项目只清除 UI 订阅和提醒，不删除项目缓存中的对话。第 4 步测试预览的恢复只覆盖项目工作区、查看器和未保存文本；正式桌面入口的对话/设置恢复由后端负责。
- 未知提交的自动核实依赖 `loadConversation` 返回包含该 `submissionId` 的运行；同标识重试依赖服务端按 `submissionId` 幂等去重。两项都是后端契约，测试适配器只在内存中模拟，不能证明真实服务幂等。
- 重连核实只遍历当前项目本地已知且未结束的对话，通过强制加载详情补齐；没有真实网络重连、退避、轮询或全项目历史扫描引擎。连接事件、断线和事件丢弃由测试适配器模拟。同步代次只保留每个项目最近一次待补核实，确保单次在途、无并发放大；没有持久化重试队列。
- 重试未发出和原未知提交未接受是两种不同结论：前端不会因一次重试 not-sent/取消/异常而清除原 `pendingSubmission`；真实服务必须继续按 `submissionId` 幂等，且 `loadConversation` 必须能返回已接受运行，才能完成核实。
- 后台通知是单一替身槽：同时到达的多个终态以后到者显示，不建立通知中心或未读列表。通知状态记录只在当前 App 内存中；模态禁用、隐藏面板和查看定位由 App 层测试覆盖；约 4 秒/7 秒的自动消失是常量，未用真实秒级等待做测试。
- 测试预览的附件预览使用测试适配器提供的临时 URL/token；正式桌面入口的附件选择、持久化记录、临时预览句柄和资源生命周期由后端提供，前端只使用不透明标识。
- 依赖设置的正式前端契约已由桌面后端实现真实 CLI 检测、ChatGPT OAuth、模型 API 测试、工具箱扫描和环境命令检测；在线外部成功仍受账号/网络/隔离凭据限制。测试预览中的路径、账号、连接结果、服务、环境状态和保存配置仍来自 `test/` 内存适配器。
- 设置快照只返回 `hasKey`，真实密钥安全保存、替换和连接测试均由后端承担；前端没有密钥持久化、日志或样例密钥。
- 测试预览中的设置保存只写入内存；正式桌面入口的设置保存由后端持久化，重启后从后端快照恢复。测试适配器保存当前服务后会同步测试对话上下文；正式后端在保存成功后提供等价的新 `getContext` 结果，相关真实服务切换由桌面/存储回归覆盖。
- `chatgpt-test-service`、`ChatGPT Test Model` 和 `settings-api-unavailable` 是仅用于测试的稳定身份，不代表真实 ChatGPT 或后端不可用服务；正式桌面入口按实际账号、CLI、模式和配置服务返回上下文及原因。
- “取消设置取消未完成授权”依赖 `cancelChatGptLogin`；“已完成登录/退出不回滚”以能力返回的实际状态和 `subscribeUpdates` 为准。测试适配器模拟了取消竞态，但没有真实 OAuth 回调、网络撤销或服务端会话。
- 工具箱扫描结果与新建项目的同源依赖后端 `scanToolboxes`/`listToolboxes` 一致；正式后端按文件夹名扫描并原位加载。

## 本阶段明确未实现

- 安装包、自动更新、托盘和后续业务后端；桌面主进程/preload/IPC、SQLite 基础、第 4 步工作区恢复已由后端完成，见 `docs/backend-development.md`。
- 后端真实项目/文件系统、最近项目、文件写盘、工作区/布局/查看器状态与恢复副本持久化已完成；对话、消息、运行、提交、审批、附件、设置与密钥也已由后端 SQLite/文件持久化。测试预览仍只使用内存模拟。
- 真实 HDF5 解析、正式 HTML 预览资源服务已完成；编辑器内的代码执行、补全、格式化、搜索替换和图片编辑未实现。
- H5 通用大数据平台、跨数据集持久缓存或可配置分块策略；当前仅实现查看器所需的有界窗口。
- 消息排队、后台任务引擎、多人协作和云端能力。
- 通知中心、未读列表、跨服务会话迁移和历史搬运。
- 真实在线模型下的多轮专业工具编排、FGM 求解、流形表生成和报告算法；第 7 步已完成通用执行、环境与审批链路，专业算法继续由工具箱承载。
- 独立的后台任务队列/调度器；当前运行任务由对话运行与提交记录持久化表达，未建立单独的任务表或独立调度器。
- 项目关闭时的后端资源释放接口；当前关闭只结束 UI 会话，后续可扩展 `closeProject` 能力。
