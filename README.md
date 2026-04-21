# Super Clip

**Windows 上更懂你的剪贴板管理器。** 文本、富文本、图片、文件一网打尽;内置离线 AI OCR 让截图里的字变成可搜的文本;和 Everything 深度联动,剪贴板历史和本机全盘搜索在同一个窗口里解决。完全本地运行 —— 不联网、不登录、不上报。

基于 Rust + Tauri + React,事件驱动监听剪贴板,空转 CPU ≈ 0%。

---

## 为什么选 Super Clip

对标 Ditto / Paste / ClipboardFusion / Copy'Em 的核心差异:

| | Super Clip | 大多数剪贴板管理器 |
|---|---|---|
| 富文本格式保留 | 完整捕获 Windows CF_HTML,粘回 Word/邮件时字体、颜色、链接、表格都在 | 只保留纯文本,格式全丢 |
| 图片 OCR | 内置离线 ONNX 中英文模型,图片里的字可搜、可框选、可单句复制 | 不支持,或需要联网 |
| 全局搜索 | 剪贴板历史 + Everything 本机文件 统一搜索(Ctrl+M) | 只能搜自己的历史 |
| 备份迁移 | 一键 JSON 导出/导入,图片 base64 内嵌,换机器无损恢复 | 数据锁死在本地,迁移痛苦 |
| 隐私 | 纯本地,敏感应用(KeePass/1Password 等)自动不记录 | 多数上云同步 |
| 性能 | 事件驱动监听,SQLite WAL + mmap,十万条仍流畅 | 轮询扫描,条数多了会卡 |

---

## 核心功能

### 智能捕获与存储

- **四种内容全支持** — 纯文本、链接、代码、图片、文件路径,自动分类并带颜色标签
- **富文本 (HTML) 保留** — 从 Chrome / Word / 飞书 / Notion / Gmail / Slack 复制的带格式内容,粘到支持富文本的目标里格式完整保留;粘到记事本自动降级纯文本
- **事件驱动监听** — Win32 `WM_CLIPBOARDUPDATE` 消息泵,空转零开销;非 Windows 平台回退到 300ms 轮询
- **智能去重** — 文本按内容精确去重,图片按像素 SHA-256 去重
- **敏感应用黑名单** — 从 KeePass / 1Password / Bitwarden / LastPass 等密码管理器复制的内容永不入库,支持自定义进程名

### 离线 OCR(本地 AI)

- **ONNX Runtime + RapidOCR** 中英文检测 + 识别双模型,全在你的 CPU 上跑
- **飞书式交互** — 鼠标悬停任一图片 clip 即触发识别,识别后可框选文本片段、整句复制或复制全文
- **大图预缩放** — 超过 1280px 宽的图片自动按比例缩放后再推理,节省内存和时间
- **模型常驻内存** — 首次加载后一直留在进程内,每次 OCR 从 ~500ms 降到 ~0ms

### 极简搜索模式(Ctrl+M)

一个 Spotlight 风格的小窗口,按类别过滤:
- **剪贴板历史** — 模糊匹配(nucleo-matcher)你的 content + OCR 文本 + 来源应用 + 标签
- **本机文件** — 通过 Voidtools Everything SDK,瞬时搜索整块硬盘
- **分类 Tab** — 全部 / 剪贴板 / 本地文件 / 文档 / 图片 / 链接 / 代码 / 应用 / 文件夹 互相切换

### 主界面

- **分页 + 无限滚动** — 每页 100 条,`IntersectionObserver` 懒加载,不卡
- **时间桶导航** — 浮动侧边条按语义分组:1 小时内 / 今日上午 / 今日下午 / 今晚 / 昨天 / 最近 7 天 / 更早
- **三层过滤叠加** — 标签类型(文本/图片/链接/代码/文件/收藏) + 关键词搜索 + 时间范围,实时联动
- **多选批量操作** — 拖拽框选多条 → 合并复制 / 批量删除
- **实体智能提取** — 选中带邮箱/URL/电话/IP/颜色值/JSON 的 clip 自动识别并给出对应操作按钮(发邮件、打开链接、格式化 JSON、显示色卡等)

### 代码片段(Snippets)

- 命名 + 可选触发词(如 `;;email`),在极简模式搜索时直接出现在结果里
- 常用 email 签名、回复模板、命令片段永不丢失
- 设置面板内完整 CRUD

### 悬浮图片窗口

- 任意图片一键固定为 **置顶、透明、可缩放** 的悬浮窗
- 窗口上叠一层 OCR 文字层,可直接框选复制(用于一边查图一边打字)

### 内置仪表盘

本地 `Intl.Segmenter` 分词,零 LLM 依赖:

- **分类分布** — 堆叠条 + 圆环图,一眼看文本/图片/链接比例
- **来源应用 Top15** — 条形图告诉你剪贴板最常从哪些应用来
- **高频词气泡图** — 6 色渐变,大小反映频次,点击即把该词当筛选器应用回主列表
- **时间范围切换** — 30 分钟 / 2 小时 / 3 小时 / 1 天 / 3 天 / 全部

### 数据管理 — 敢于 all-in

- **一键导出 JSON** — 全量历史 + 代码片段打包,图片以 base64 内嵌,文件可跨机器还原
- **合并导入策略** — 相同内容自动跳过,绝不覆盖现有历史;错误条目单独计数
- **自动清理** — 保留策略(1 / 7 / 30 / 90 天 / 永久)可选,已置顶和已收藏的条目永不被清理
- **DB schema 版本化迁移** — 新字段加得安全,老数据平滑升级

### 键盘驱动

| 快捷键 | 动作 |
|---|---|
| `Ctrl+Space` (可改) | 显示/隐藏主窗口 |
| `Ctrl+M` (可改) | 极简搜索模式 |
| 双击 `Ctrl` | 快速呼出/隐藏(可关闭) |
| `Enter` | 复制当前条目并自动粘贴到上一个窗口 |
| `↑/↓` `Tab` | 列表 / Tab 切换 |
| `ESC` | 分层返回(预览→设置→弹窗→多选→筛选→搜索→隐藏) |
| `?` | 完整快捷键面板 |

### 界面

- Obsidian 风深色主题,石墨灰 + 电光蓝配色;支持明暗一键切换
- 支持中文 / 英文一键切换,所有 245+ 文案完整翻译
- 毛玻璃层叠 + 呼吸 Logo + 渐变动画

---

## 隐私

Super Clip 是严格的 **本地优先** 软件:

- 剪贴板数据**永不离开**你的机器
- OCR 在本地 CPU 跑,无云端推理
- 没有账号、没有遥测、没有分析
- 敏感应用可配置黑名单,从源头阻断入库
- 代码 MIT 开源,欢迎审计

---

## 安装 / 构建

### 前置依赖

- [Node.js](https://nodejs.org/) v18+
- [Rust](https://rustup.rs/) 最新稳定版
- Visual Studio C++ Build Tools(Windows 编译 Rust 需要)
- [Everything](https://www.voidtools.com/) 运行中(本机文件搜索需要,可选)

### 从源码运行

```bash
git clone https://github.com/huangmang/super-clip.git
cd super-clip
npm install
npm run tauri dev
```

### 构建安装包

```bash
npm run tauri build
```

产物在 `src-tauri/target/release/bundle/nsis/` 下,包括 `.exe` 安装包和 `.msi`。

---

## 技术栈

- **前端** — React 18 + TypeScript + Vite + TailwindCSS + DOMPurify
- **后端** — Rust + Tauri 1.5,rusqlite(bundled SQLite)持久化,WAL + mmap 加速
- **AI** — ONNX Runtime (`ort` crate) 本地推理,RapidOCR 中英双语模型
- **Windows 深度整合** — 低级键盘钩子、`WM_CLIPBOARDUPDATE` 事件、`CF_HTML` / `CF_UNICODETEXT` 双写、Everything SDK 桥接

---

## 贡献

欢迎提 Issue / PR。功能建议、Bug 汇报、翻译都欢迎。

## 许可

MIT License
