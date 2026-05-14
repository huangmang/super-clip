# 更新日志 (Changelog)

所有对 Super Clip 的重大功能改进和 Bug 修复都会记录在此。

## [0.7.0] - 2026-05-14

### OCR 引擎升级

- **PP-OCRv4 server → PP-OCRv5 server** — det 113 MB → 84 MB / rec 90 MB → 80 MB（净省 40 MB），dict 6622 → 18383 字符（中英日繁体 + 拼音 + 更多符号）。RapidOCR ONNX 镜像，SHA256 校验。
- **rec 动态宽度** — v4 时代固定 W=320 把任何宽高比 >6.7:1 的行强压成 320×48，长邮箱 / URL / 中英长句基本失效。v5 rec 输入 W 是 dynamic dim，按 native 纵横比缩放到 H=48 + 8 倍数对齐。实测："Email: alice@example.com / Tel: 021-88881234" 从 `Eal`(0.641) → 完整(0.989)。
- **rec batched → per-line forward** — 不同宽度无法 stack 成 batch，每行独立 `session.run`；用 dynamic W 换准确率，per-line 开销在 warm session 下可接受。
- **fetch_name_0 输出名兼容** — v5 ONNX 输出节点重命名，加进 fallback 链表前优先匹配。
- **小图 upsample** — Windows OCR fallback 路径 <800px 时 2× Lanczos3 放大，挽回 UI 细字。

### OCR 性能

- **后台预加载** — 新增 `ocr_preload` 模块（单 worker + bounded VecDeque 容量 4 + Condvar 唤醒）。剪贴板进图后 `clipboard_monitor::handle_new_clip` 和 `commands::user_prompt_decision` 立即 enqueue；worker 跑 `recognize_text_local` 写入 `clips.ocr_lines`。用户后续点击图片时 `perform_ocr` 直接命中 DB 缓存，**0 延迟出结果**。溢出丢最老（最新粘贴更可能被打开），同 clip_id 自动去重，cache double-check 防重跑。完成后 emit `ocr:preloaded` 事件。
- **ORT GraphOptimizationLevel::Level3** — 之前用默认（Level1）。开启常量折叠 + op fusion + layout 传播，稳态推理 20-30% off。
- **Dummy warmup pass** — `LocalOcrEngine::warmup()` 在 `warm_start` 后跑一轮 `det(1,3,64,64)` + `rec(1,3,48,320)` 假输入，把 first-inference 开销（kernel dispatch / arena bootstrap / threadpool init）提前到 app 启动时。实测 0.61s 完成。
- **冷启动 26.47s → 稳态 3.24s**（5 行截图，warm session）—— 约 8× 加速。

### OCR 交互（视觉系统重构）

- **GlassSurface 设计基元** — 新增 `src/components/GlassSurface.tsx` 暗玻璃 card/pill 两变体 + accent stripe（indigo/emerald/amber）+ `GLASS_TOKENS` 常量导出（渐变底 / blur / hairline ring / topHighlight / 多层 shadow / 入场动画 class）。所有 overlay 单点改造可换肤。
- **统一 8 处 overlay 视觉** — copy toast / hover tooltip / OCR-done hint / 多选 pill / 搜索框 / 加载指示 / 右键菜单 / smart link chips 全部迁到 GlassSurface。原先 5 套背景 / 3 套 shadow / 不一致动画 → 一套语言。
- **IconButton 组件 + 工具栏 config 化** — 顶部 7+ 控件改为 `toolbarActions: Action[]` 数组驱动，加按钮 = push 一条记录。5 种 accent 色（indigo/emerald/amber/rose/red），统一 active/disabled/hover 态，`disabled:hover:bg-black/50` 修掉 disabled 按钮 hover 仍变色的小 bug。
- **新增 ImageOcrViewer 组件** — 把 FloatImage 里 200+ 行图片浮窗逻辑拆出来作为单一来源，FloatImage（独立窗口）和主 App 预览 modal 共享同一个交互组件。
- **Raycast 风 hover tooltip** — 替换浏览器原生 `title=` 黄色小框：暗玻璃 + 顶部 indigo 渐变条 + 小箭头指向行 + 单行布局（文字左 + 置信度点 + 百分比右）+ 圆角 12px + 多层阴影 + 拖拽选字时自动隐藏避免干扰 + 视图变化时清掉防错位。
- **复制成功 toast 重做** — 从 `bg-green-500 + text-white`（对比度 2.55，白底图基本看不见）→ 暗玻璃 + emerald 渐变图标球 + 内高光 + 外发光 + 加重 strokeWidth。任意底色 WCAG AAA。
- **全局 Toast 改不透明** — 新增 `--panel-bg-solid` CSS 变量（暗 #161b22 / 亮 #ffffff），`已复制到剪贴板` toast 不再用半透明 panel-bg/95 + blur，任何底图字都清晰。

### OCR 性能（前端）

- **OCRLayer sortedLines memoize + 预算 bbox** — 之前每次 render 重 spread+Math.min/max × N 行 × 4 维度。现 `useMemo` 一次性算出 `EnrichedLine[]` 含 `{minX, maxX, minY, maxY}` 缓存。marquee 命中测试、line render map、hover anchor 三处统统读 `.bbox`。pan/zoom tick 不触发该计算。
- **selectionchange rAF 节流** — 拖拽选字时浏览器秒发 60+ 事件，原代码每次 setState。改为 requestAnimationFrame 合并，max 1 次 setState/frame。
- **rec 长行不再压扁** — 见上「OCR 引擎升级」。

### Bug 修复 / 安全

- **路径校验** — `recognize_text` 安全路径白名单保留，新模块沿用。
- **预加载 worker 异常隔离** — 失败仅 `eprintln`，DB 状态保持「无 OCR 数据」让用户点击时同步路径兜底。
- **同 clip 重复 enqueue 去重** — 用户连续粘相同图防止队列堆叠。
- **空 ocr_lines/`[]` 不视为缓存命中** — 修历史脏数据导致永久卡 0 行的 bug。

### 开发 / 项目

- **`.gitignore` 加 `src-tauri/resources/`** — 165 MB ONNX 模型不入库，README 后续会写从 RapidOCR ModelScope 下载脚本。
- **smoke_test.py** — Python + onnxruntime 端到端验证脚本（生成中英日测试图、跑 det+rec、对比固定 320 vs 动态宽差异、计时）。本地诊断用。

### 非功能性

- 改动跨 ~13 文件 / +1500 / -380 行
- 8 个 overlay 视觉迁到统一基元
- 顶部工具栏 100+ 行重复 JSX → 配置数组驱动 + IconButton

---

## [0.6.0] - 2026-05-08

### Bug 修复

- **富文本复制"粘贴为空"** — 根因：`clipboard-win` 4.5 的高层 `Setter` API 内部每次 `SetClipboardData` 前都调 `EmptyClipboard()`，连写 CF_UNICODETEXT + CF_HTML 时后者的 empty 把前者抹掉。Notepad 读不到 CF_UNICODETEXT → 粘贴为空。**修复**：改用 `raw::set_without_clear` 在单个 OpenClipboard 会话内原子写入两个格式。回归测试全绿。
- **try_read_cf_html 解析失败回退 raw blob** — 以前 parse 失败会把整段带 `Version:0.9` 头的 CF_HTML 原始数据存进 DB；复制时 `build_cf_html_blob` 再包一层产生嵌套头部，Word/浏览器拒绝渲染。现在解析失败直接返回 None，该 clip 走纯文本路径。
- **DB v2 迁移** — 清理历史中已入库的脏 `content_html`（`WHERE content_html LIKE 'Version:0.%'`），确保老用户升级后不再触发上述嵌套头部。

### 交互改进

- **主窗口改双击复制** — 单击仅选中卡片（避免误触），双击才真正复制到剪贴板。右上角 Copy 按钮和 Enter 键仍为显式复制入口。极简弹窗（Ctrl+M）保留单击复制+粘贴（uTools 流）。
- **批量删除** — `window.confirm` 替换为自建模态确认框，风格与清空历史、其他 confirm 统一。
- **快捷键帮助面板** — 新增「Double-click → 复制到剪贴板」说明，旧的「Click → 复制」改为「Click → 选中卡片」。
- **首次启动 Onboarding** — 4 步引导覆盖 Ctrl+Space / Ctrl+M / 双击复制 / Enter 自动粘贴，`localStorage` 标记只弹一次。

### 安全 & 稳定性

- **OpenProcess Handle 泄漏** — `detect.rs` 每次 `get_active_window_process_name` 后 `CloseHandle`。权限从 `PROCESS_QUERY_INFORMATION|VM_READ` 收紧到 `PROCESS_QUERY_LIMITED_INFORMATION`。
- **perform_ocr / open_path 路径白名单** — 拒绝 `shell:` / UNC / 协议 URI，强制 canonicalize + 存在性校验，OCR 还要求已知图片后缀。
- **user_prompt_decision 锁顺序** — 先 `take` PendingClipState 释放锁再 lock DB，消除 ABBA deadlock 窗口。
- **DOMPurify 加 on* 全属性 hook** — `uponSanitizeAttribute` 兜底丢弃任何以 `on` 开头的属性，不再依赖逐个枚举。

### 性能

- **SyntaxHighlighter 懒加载** — `react-syntax-highlighter`（~200KB）改为 dynamic import，首屏不再等语言模块下载。新增 `LazyCodeBlock.tsx`。
- **图片 hash 两阶段** — 先 SHA256(头 4KiB + 尾 4KiB + length)，命中再全量 hash。4K 截图 (~33MB) 常态从 ~50ms 降到微秒级。
- **vite manualChunks** — react / lucide / dompurify / tauri-api 各拆独立 chunk，WebView2 可增量缓存。
- **clipboard_monitor 错误上报** — `insert_clip` 失败时 emit `clip:error` 事件给前端，不再静默吞掉 DB 锁 / 磁盘满等问题。

### i18n 全量覆盖

- `getGroupLabel` 重构为 `getGroupKey`（stable enum），时间分组文案接入 `t('time.*')`。修复 midnight 跨天 diffDays 计算 bug。
- 空状态 / Copy Confirm Modal / Dashboard RANGES & typeConfig / Settings.tsx 33 处硬编码中文全部接入 i18n。
- 新增 35+ i18n key（settings.* / modal.* / search.* / onboard.* / mini.everything_* / dash.*）。
- i18n.ts 去重 11 条冲突 key。

### 产品 / UX

- **系统主题跟随** — 主题循环：dark → light → auto。`auto` 模式监听 `prefers-color-scheme` 变化实时切换。
- **窗口位置/大小记忆** — `onMoved` / `onResized` debounced 存 localStorage，下次启动恢复。
- **Everything 友好降级** — SDK 错误分类为 NOT_INSTALLED / NOT_RUNNING，极简弹窗显示对应修复提示。

### 开发体验

- **GitHub Actions CI** — push/PR 自动跑 `cargo test` + `tsc` + `vite build`（`.github/workflows/ci.yml`）。
- **lint 配置** — `rustfmt.toml` + `clippy.toml`；`package.json` 新增 `typecheck` / `lint:rust` / `fmt:rust` / `test:rust` scripts。
- **Tauri Updater 占位** — `tauri.conf.json` 配好 endpoints / dialog / pubkey 字段（`active: false`，待维护者配签名密钥后启用）。文档 `docs/UPDATES.md` 详细说明密钥生成 + GitHub Release 发布流程。
- 清除 App.tsx 12 处 `console.log("[DEBUG]...")` 残留。
- 修 `ocr.rs` unused import + `clipboard_monitor.rs` unused Result warning → 0 warning build。

### README 重写

- 首屏 tagline + ASCII 三栏对比图 + 「三件事决定你装不装」场景化卖点
- 30 秒上手前置 + 对比表简化 + 用户画像
- 完整功能改 `<details>` 折叠

---

## [0.5.0] - 2026-04-21

### 富文本 (HTML) 保留 — 补齐最大短板

对标 Ditto / Paste 做产品审视后,富文本丢失是用户最易劝退的短板。本版本完整支持 Windows `CF_HTML` 格式的捕获、存储与粘贴回写 —— 从 Chrome / Edge / Word / 飞书 / Notion / Gmail / Slack / Obsidian 复制过来的带格式内容,粘到支持富文本的目标里时格式会被完整保留。

- **CF_HTML 捕获**(`src-tauri/src/clipboard_monitor.rs`):每次 text clip 进库时,额外读取 Windows `CF_HTML` 剪贴板格式。手写 `parse_cf_html_fragment()` 按 `StartFragment:` / `EndFragment:` 字节偏移提取用户实际选中的片段,跳过浏览器/Office 塞进来的样板 HTML。
- **CF_HTML 回写**(`src-tauri/src/commands.rs`):`copy_to_clipboard` 支持新的 `content_html` 可选参数,在 Windows 侧按规范构造 `Version:0.9 / StartHTML / EndHTML / StartFragment / EndFragment` 4 组 10 位字节偏移,原子写入 `CF_UNICODETEXT + CF_HTML`。粘进 Word / 邮件 / IM 时保留格式,粘进记事本时自动降级成纯文本。
- **列表内渲染**:文本 clip 行内直接渲染富文本(加粗、颜色、链接、列表、表格),用 `DOMPurify` 严格白名单清洗(禁 `<script>` / `<iframe>` / `on*` 事件);超过 50KB 的 HTML 自动降级到纯文本视图防止性能问题。
- **琥珀色 "RTF" 徽章**:列表每条支持富文本的 clip,type badge 旁多一个醒目的 RTF 小标签 + tooltip 说明,一眼可识别。

### 导出 / 导入 JSON — 让用户敢 all-in

之前剪贴板历史完全锁死在本地 SQLite,不能备份不能迁移,心理上"只是个玩具"。本版本补上全量备份/恢复通道。

- **导出**(`export_clips_to_json`):Settings → 数据管理 → "导出为 JSON"。一键把所有 clips + snippets + 当前 app 版本号打包到 JSON。图片 clip 以 base64 内嵌,保证跨机器 round-trip(换电脑恢复不丢图)。成功 toast 显示条数和文件大小。
- **导入**(`import_clips_from_json`):Settings → 数据管理 → "从 JSON 导入"。**合并去重策略** —— 相同 `content + type` 的条目自动跳过,绝不覆盖现有历史;新图片按 SHA-256 去重后落入 images 目录。事务内批量 insert,5000 条 < 1s。结果 toast: `新增 N / 跳过 M / 片段 K / 错误 E`。
- **数据自包含**:导出包含 `version / exported_at / app_version / clips[] / snippets[]`,未来字段扩展时自动向后兼容(带 `version` 校验,新版本 JSON 导入老版本会明确报错)。

### DB Schema 迁移机制

由于本版本需要给 `clips` 表新增 `content_html` 列,顺手把多年来的 "`CREATE TABLE IF NOT EXISTS` + 一串吞错误的 `let _ = ALTER TABLE`" 补丁升级为正式版本化迁移:

- 引入 `PRAGMA user_version` 跟踪 schema 版本,历史库启动时自动走 v0 → v1 升级路径。
- 新字段:`clips.content_html TEXT`,可空,向后兼容所有老数据。
- `insert_clip` 重复 content 时用 `COALESCE` 补齐历史缺失的 html(以前存过的纯文本,下次再复制时自动获得 RTF 版本)。

### 体验微调

- **高频词气泡字号放大**(`Dashboard.tsx`):之前数量是 8px 且仅 hover 才显示,靠直觉找不到;改为词 13-19px + 数量 11-14px 常驻在词下方,气泡最大直径 92px → 112px,一眼看到"词 + 频次"两个核心信息。
- **i18n 新键**:`badge.rich_text`、`settings.data_management`、`settings.export`、`settings.import`、`settings.export_success`、`settings.import_confirm`、`settings.import_success` 等,中英双语完整覆盖新功能。

### 依赖新增

- `dompurify ^3.4.0` + `@types/dompurify`(前端 HTML 清洗)
- `base64 = "0.21"`(Rust 侧 JSON 导出时图片编码)

---

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
