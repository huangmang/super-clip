# 更新日志 (Changelog)

所有对 Super Clip 的重大功能改进和 Bug 修复都会记录在此。

## [0.4.1] - 2026-04-15

### 产品体验优化

- **单击即复制**：去掉复制确认弹窗，单击 clip 卡片直接复制到剪贴板，零摩擦。
- **撤销删除**：删除操作改为即时删除 + 3 秒撤销条（带倒计时进度条），替代原来的确认弹窗。
- **全局 Toast**：复制成功反馈改为屏幕居中大 Toast + 勾选动画（1.5 秒），替代原来底部小字。
- **快捷键面板**：按 `?` 键弹出快捷键帮助面板，列出所有 11 个快捷键及说明。Footer 也有入口。
- **ESC 分层返回**：ESC 键按优先级逐层退出（预览→设置→弹窗→极简→多选→过滤→搜索→Tab→隐藏窗口）。
- **空状态引导**：区分首次使用（欢迎页 + 快捷键提示）、搜索无结果、筛选无结果三种空状态。
- **操作栏键盘可见**：clip 卡片的操作按钮在键盘选中时也显示，不再仅限 hover。
- **收藏/置顶动画**：点击收藏或置顶时图标弹性缩放反馈。

### 国际化 (i18n)

- **中英文切换**：新增 `src/i18n.ts` 轻量 i18n 系统（153 个翻译键，支持插值），Settings 右上角一键切换语言。
- **全组件接入**：App.tsx、Dashboard.tsx、MinimalistView.tsx、Settings.tsx、PromptModal.tsx、FloatImage.tsx 全部完成硬编码文本替换。

### 仪表盘重构

- **数据源统一**：Dashboard 不再独立查后端统计，改为接收主列表 `clips` prop，用前端同一套 `TIME_FILTER_MS` 逻辑计算统计，彻底消除数据不一致问题。
- **堆叠条总览**：分类和来源应用区块上方各加一条水平堆叠条，hover 显示 tooltip，一眼看占比。
- **条形卡片风格统一**：分类分布和来源应用统一为带颜色图标 + 渐变填充条 + hover 发光的卡片列表风格。
- **气泡图词频**：高频词从药丸标签改为气泡图，大小/透明度反映频率，6 色渐变 + 浮动动画 + hover 弹出计数。
- **时间选择器**：从一行挤压改为 3×2 网格按钮，更大点击区域。
- **默认一天**：仪表盘默认展开且默认选中"一天"，与主列表一致。
- **面板宽度**：`clamp(320px, 30vw, 480px)` 自适应高分屏。
- **时区修复**：后端时间范围查询从 SQLite `datetime('now')` (UTC) 改为 Rust `chrono::Utc::now()` 计算阈值，与前端 `Date.now()` 一致。

### 清晰度修复

- **去除模糊源**：移除 Dashboard 容器的 `translateZ(0)` GPU 合成层、`.glass-card` 的 `backdrop-filter: blur`。
- **字体渲染**：`text-rendering` 改为 `geometricPrecision`，添加 `Segoe UI` 到字体栈，加 `font-feature-settings`。
- **SVG 优化**：`shapeRendering` 改为 `auto`，去除导致模糊的 CSS transform。
- **全局像素锐化**：添加 `backface-visibility: hidden`、`image-rendering: -webkit-optimize-contrast`。

### 动画系统

- 新增 `tailwind.config.js` 动画扩展：shimmer、glow-pulse、slide-up、scale-in、bar-fill、ring-draw、float。
- 新增 CSS 动画类：`dash-stagger`（交错淡入）、`shimmer-bg`（流光）、`glass-card`（hover 浮起）、`ring-segment`（环形绘制）、`app-bar-fill`（条形填充）、`hover-glow`（光晕）、`tag-hover`（标签弹性）、`bubble-float`（气泡浮动）。

---

## [0.4.0] - 2026-04-15

### 性能极致化

- **事件驱动剪贴板监听**：用 Win32 `AddClipboardFormatListener` + `WM_CLIPBOARDUPDATE` 消息泵替代原 300ms 轮询循环，CPU 空转从 ~3-5% 降至 ~0%。非 Windows 平台自动回退到轮询模式。
- **OCR ONNX 引擎全局缓存**：通过 `OnceLock<Mutex<Option<LocalOcrEngine>>>` 缓存 ONNX Session，避免每次 OCR 调用都重新加载两个模型文件（~500ms → ~0ms）。同时将 `keys.txt` 字典预加载到结构体中。
- **大图预缩放**：OCR 检测前自动将宽度超过 1280px 的图片按比例缩放，显著降低推理时间和内存占用。
- **DB mmap 加速**：启用 `PRAGMA mmap_size = 256MB`，利用内存映射加速大数据库的读取性能。
- **专项索引优化**：新增 3 个高命中索引 — 去重查询的部分索引 `idx_clips_dedup`（`WHERE type != 'image'`）、清理查询的复合索引 `idx_clips_cleanup`、统计查询的覆盖索引 `idx_clips_stats`。移除了冗余的全量 `idx_clips_content` 索引。
- **批量删除命令**：新增 `batch_delete_clips` 命令，单条 `DELETE WHERE id IN(...)` SQL 替代前端逐条串行调用。
- **前端分页加载**：`get_clips` 全量加载改为 `get_clips_page` 分页加载（PAGE_SIZE=100），配合 `IntersectionObserver` 无限滚动，大幅减少 IPC 数据量和 DOM 节点数。
- **filteredClips 缓存**：`clips.filter(...)` 从裸计算改为 `useMemo`，依赖 `[clips, activeTab, search, timeFilter]` 变化时才重算。

### 新功能

- **模糊搜索 + OCR 文本可搜**：集成 `nucleo-matcher` 模糊匹配引擎。搜索时同时匹配剪贴板内容、OCR 提取文字、来源应用名、标签，实现"截图里的文字也能搜到"的差异化能力。极简模式搜索自动调用后端模糊搜索（150ms debounce）。
- **敏感应用过滤（隐私保护）**：新增 `ignored_apps` 设置项（JSON 数组）。剪贴板监听检测到来源进程匹配忽略列表时自动跳过记录。Settings 中提供管理界面，支持手动添加/删除 + 一键添加预设（KeePass、1Password、Bitwarden、LastPass）。
- **实体提取 + 快捷操作**：选中剪贴板条目时自动识别内容中的实体类型（URL、邮箱、电话、IP 地址、十六进制颜色、JSON），并显示上下文操作按钮 — URL 可直接打开、邮箱一键写信、颜色显示色块预览、JSON 一键格式化复制。正则模式通过 `OnceLock` 全局编译一次。
- **代码片段模板（Snippets）**：新增 `snippets` 数据表 + 完整 CRUD 命令（`get_snippets`、`create_snippet`、`update_snippet`、`delete_snippet`）。Settings 中新增 "Snippets" Tab 管理片段（名称、内容、触发前缀）。极简搜索模式中自动合并显示匹配的片段结果（带 "Snippet" 标识），回车即可粘贴。

---

## [0.3.1] - 2026-04-15

### 架构重构

- **模块拆分**：`main.rs`（920 行）拆分为 4 个职责清晰的模块 — `commands.rs`（Tauri 命令）、`clipboard_monitor.rs`（剪贴板监控）、`detect.rs`（类型检测 + 窗口源识别）、`main.rs`（应用入口，~80 行）。
- **DB 连接池**：所有数据库操作从每次 `Connection::open()` 改为共享 `DbState(Mutex<Connection>)` 管理状态，消除高频场景下反复开关连接的开销。
- **统一错误类型**：引入 `AppError` 枚举（基于已引入但未使用的 `thiserror`），统一 `Db`/`Io`/`General` 错误变体，替代散落各处的 `Box<dyn Error>` 和 `.map_err(|e| e.to_string())`。
- **分页查询 API**：新增 `get_clips_paginated(conn, limit, offset) -> ClipPage { items, total, has_more }` 和对应的 `get_clips_page` 命令。查询不再包含 `embedding` BLOB 字段。

### 安全修复

- **SQL 注入修复**：`get_stats_by_range` 和 `get_recent_content_by_range` 中的 `format!()` SQL 拼接改为参数化查询 `datetime('now', ?1)`，并增加 `validate_time_modifier()` 白名单校验（仅允许 `-N minutes/hours/days/months` 格式）。

### 稳定性修复

- **轮询线程 panic 保护**：剪贴板轮询循环内部包裹 `catch_unwind`，单次迭代的 panic 不再导致整个监控线程终止。
- **PromptModal 窗口创建**：`.build().unwrap()` 改为 `if let Ok(window)` 优雅处理，防止 label 冲突导致崩溃。
- **URL 检测精确化**：`detect_type` 中的链接检测从子串包含（`.com`/`.cn` 等）改为 `url::Url::parse` 精确验证，消除 "apple.com 的产品" 等误判。
- **路径检测优化**：新增 `looks_like_path()` 预检函数，仅对符合路径格式的文本才调用 `path.exists()` 做磁盘 I/O。
- **图片删除路径修复**：`delete_clip` 中的图片文件删除从错误的 `app_dir.join("images").join(content)` 改为直接使用 `content` 作为绝对路径。
- **hotkey-trigger 闭包修复**：前端 `listen("hotkey-trigger")` 回调中的 `isMinimalist` 改用 `useRef` 存储最新值，避免 useEffect 频繁注册/取消监听器导致的竞态条件。

### 归一化

- **事件命名规范**：`"new-clip"` → `"clip:created"`，`"show-mode"` → `"window:show-mode"`，`"hotkey-trigger"` → `"window:hotkey-trigger"`，统一命名空间。
- **设置存储统一**：`alwaysCopyToClipboard` 从仅存 `localStorage` 改为同时写入 DB `settings` 表。
- **移除 embedding 字段**：`Clip` 结构体和查询中移除未使用的 `embedding: Option<Vec<u8>>` 字段，减少 IPC 传输量。
- **HighlightText 提取**：从渲染函数内部定义提取为顶层 `React.memo` 组件，正则转义输入防止崩溃。

### 清理

- **移除死代码**：`update_clip_embedding()`、`get_stats()` 包装函数、`start_drag` 空实现、`fix_main.py`、`test_clipboard.rs`、`base64` 依赖。
- **修复无效调用**：前端 `invoke("perform_rapid_ocr")` 改为 `invoke("perform_ocr")`，`onDragStart` 中对已删除 `start_drag` 的调用移除。
- **移除空 useEffect**：`useEffect(() => { /* Reset OCR */ }, [ocrData])` 空副作用清理。

---

## [0.2.1] - 2026-03-04

### ✨ 新功能 (Features)
- **丝滑滑动多选 (Refined Drag-to-Select)**：在记录列表上直接拖动即可自动开启多选并批量选中。支持反向拖拽调整选区，禁止系统干扰，操作极度流畅。
- **智能分词系统**：文本记录新增“智能分词”模式，可将长段文本切分为独立词块，点击即可秒速复制。
- **交互式仪表盘**：侧边栏热词标签和资产分布图现在支持点击过滤。
- **智能化识别**：增强了 Dashboard 的“自动识别助手”，支持识别任务、链接、邮箱和颜色代码。
- **uTools 风格快捷键**：按下 `Enter` 键可实现“复制+隐藏窗口+自动粘贴”的连贯操作。
- **OCR 支持**：集成 OCR 文字识别图层，支持图片内容提取（Windows 平台）。

### 🔧 改进 (Improvements)
- **全方位系统加固 (Robust Backend)**：系统性清理了所有潜在的 `unwrap()` 崩溃点，并在关键的全局热键与钩子回调中加入了异常保护，极大提升了长时间运行的稳定性。
- **丝滑滑动多选 (Refined Drag-to-Select)**：在记录列表上直接拖动即可自动开启多选并批量选中。支持反向拖拽调整选区，禁止系统干扰，操作极度流畅。
- **统一剪切板处理**：重构了 `Ctrl+C` 逻辑，优先处理选中文本，无选中时复制当前行，确保操作符合直觉。
- **搜索算法优化**：改进了过滤机制，避免 “te” 等短词误匹配到所有 “text” 类型记录，搜索更精准。
- **选择稳定性**：在用户选中文本时自动锁定高亮行，防止鼠标移动干扰复制操作。
- **重复项处理**：重复复制相同内容时会更新时间戳并置顶，而非静默忽略。

### 🐛 Bug 修复 (Bug Fixes)
- **通信协议修复**：解决了前端与 Rust 后端之间由于参数命名不一致导致的复制失败问题。
- **UI 细节优化**：修复了多选模式下的视觉反馈，并优化了深色主题的层级感。

### 🧹 工程化 (Engineering)
- **项目清理**：移除了所有临时开发文档和日志，精简了仓库体积。
- **规范化忽略**：完善了 `.gitignore`，防止 node_modules 和 build 产物进入版本库。
- **自动化发布**：配置了 GitHub Actions (`release.yml`)，支持全平台自动构建发布。

---

## [0.1.0] - 2026-03-04 (Initial Release)
- **核心功能**：实现基础的剪贴板监听与 SQLite 持久化存储。
- **基础 UI**：基于 Tauri + React + Tailwind CSS 构建的现代化主界面。
- **分类管理**：支持文字、图片、文件、链接等基础分类。
