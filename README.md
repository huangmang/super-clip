# Super Clip

> **比 Win+V 强 10 倍的本地剪贴板管家。** 富文本不丢格式、图片能搜文字、本机文件一起搜——离线、零联网、零账号。

```
┌─────────────────────┬──────────────────┬────────────────────┐
│  Word/飞书复制过来  │  截图复制过来    │  Ctrl+M 弹窗一搜   │
│  ↓                  │  ↓               │  ↓                 │
│  粘到任何地方       │  30 秒后整张图   │  剪贴板历史 +      │
│  字体颜色表格全在   │  里的字变成可    │  本机 D 盘文件     │
│                     │  搜索的文本      │  一起出来          │
└─────────────────────┴──────────────────┴────────────────────┘
        别家：纯文本           别家：不支持        别家：只有自己的历史
```

---

## 三件事，决定你装不装

### 1. 复制 Word 公文 → 粘贴到飞书，**加粗 / 颜色 / 链接 / 表格 0 损失**
Windows `Ctrl+V` 复制了带格式的内容，Win+V 历史里再粘出来就只剩纯文本——颜色没了、加粗没了、表格散架。Super Clip 完整捕获 Windows `CF_HTML`，粘到 Word / 飞书 / 邮件 / Notion 时格式原样回来；粘到记事本自动降级为纯文本，不会出现一堆 `<p style="…">` 垃圾。

### 2. 截图丢进剪贴板 → **30 秒后图里的字可搜可框选**
RapidOCR 中英双语 ONNX 模型直接跑在你的 CPU 上，不联网。屏幕截图、扫描件、表情包文字、产品截图——任何图片复制进来，鼠标悬停就触发识别，可以**框选其中一段文字单独复制**，也可以一键复制全部识别结果。模型常驻内存，第二次起耗时几乎为零。

### 3. `Ctrl+M` → **剪贴板历史 + 整块硬盘文件 在同一个窗口里搜**
Spotlight 风格小窗，模糊匹配你的剪贴板内容、OCR 结果、来源应用名——同时通过 [Everything](https://www.voidtools.com/) SDK 桥接，整盘文件秒级返回。`Tab` 切类别，`↑↓` 选，`Enter` 复制并粘贴到上一个窗口（uTools 流）。

---

## 30 秒上手

```bash
git clone https://github.com/huangmang/super-clip.git
cd super-clip
npm install
npm run tauri dev
```

启动后：

| 按键 | 作用 |
|---|---|
| `Ctrl+Space` | 显示 / 隐藏主窗口（可改） |
| `Ctrl+M` | 极简搜索弹窗 |
| 双击卡片 | 复制到剪贴板 |
| `Enter` | 复制并自动粘贴到上一个窗口 |
| `?` | 完整快捷键面板 |

---

## 它和别家不一样在哪

对标 Ditto / Paste / ClipboardFusion / Copy'Em / Win+V：

| | Super Clip | 大多数同类 |
|---|---|---|
| **富文本格式** | CF_HTML 完整双写，粘回 Word / 飞书 / Notion 颜色表格全保留 | 只存纯文本 |
| **图片 OCR** | 离线 ONNX 中英文模型，可框选可单句复制 | 不支持，或要联网订阅 |
| **本机搜索** | 历史 + Everything 全盘，统一窗口 | 只搜自己的历史 |
| **备份迁移** | 一键 JSON，图片 base64 内嵌，跨机器无损 | 数据锁死本地 |
| **隐私** | 全本地，密码管理器自动黑名单 | 多数走云同步 |
| **CPU 占用** | 事件驱动 `WM_CLIPBOARDUPDATE`，空转 ≈ 0% | 多数定时轮询 |
| **开源** | MIT，敢审 | 多数闭源 |

---

## 适合谁

- **写文档 / 做 PPT / 跨平台搬运图文的人** —— Word ↔ 飞书 ↔ 微信 ↔ 邮件，格式不再丢
- **设计师 / 截图剁手党** —— 一天 50 张截图，OCR 让每张都可搜
- **开发者 / 运维** —— 命令、配置片段、错误日志混着用，模糊搜一下都在
- **用 Everything 的重度文件用户** —— 现在剪贴板和本机文件搜索是同一个 Ctrl+M
- **隐私洁癖者** —— 没账号、没遥测、剪贴板永不出本机

---

## 完整功能

<details>
<summary><b>智能捕获 & 存储</b></summary>

- 文本 / 链接 / 代码 / 图片 / 文件路径 自动分类，颜色标签
- **CF_HTML 富文本保留**：捕获 + 写回都按 Microsoft 规范双格式（`CF_UNICODETEXT` + `HTML Format`）原子写入
- **事件驱动监听**：`WM_CLIPBOARDUPDATE` 消息泵，空转零 CPU
- 文本按内容精确去重，图片用两阶段 hash（头尾 4KiB → 全量 SHA256）避免 4K 截图卡顿
- 敏感应用黑名单：KeePass / 1Password / Bitwarden / LastPass 复制的内容永不入库

</details>

<details>
<summary><b>本地离线 OCR</b></summary>

- ONNX Runtime + RapidOCR 中英双模型（detection + recognition）
- 鼠标悬停图片即触发，识别后**可框选片段单独复制**
- 大图（>1280px）自动按比例预缩放，节省内存
- 模型首次加载后常驻进程，二次推理几乎为零

</details>

<details>
<summary><b>极简搜索 (Ctrl+M)</b></summary>

- 模糊匹配（nucleo-matcher）：内容 + OCR 文本 + 来源应用 + 标签
- 同窗口接 Everything SDK 搜整块硬盘
- 类别 Tab：全部 / 历史 / 文件 / 文档 / 图片 / 链接 / 代码 / 程序 / 文件夹

</details>

<details>
<summary><b>主界面</b></summary>

- 分页 + 无限滚动（IntersectionObserver），每页 100 条
- 时间桶导航：1 小时内 / 今日上午 / 今日下午 / 今晚 / 昨天 / 最近 7 天 / 更早
- 三层过滤：类型 + 关键词 + 时间，实时联动
- 多选批量：拖拽框选 → 合并复制 / 批量删除（自建确认弹窗）
- 实体智能提取：选中带 email / URL / 电话 / IP / 颜色值 / JSON 的 clip 自动给操作按钮

</details>

<details>
<summary><b>代码片段 (Snippets)</b></summary>

- 命名 + 触发词（如 `;;email`），极简模式搜索时直接出现在结果里
- 设置面板内完整 CRUD

</details>

<details>
<summary><b>悬浮图片窗口</b></summary>

- 任意图片一键固定为 **置顶 / 透明 / 可缩放** 的小窗
- 上叠 OCR 文字层，框选即复制（一边查图一边打字的场景）

</details>

<details>
<summary><b>仪表盘</b></summary>

- 本地 `Intl.Segmenter` 分词，零 LLM 依赖
- 分类堆叠条 + 圆环图 / 来源应用 Top15 / 高频词气泡 / 时间范围切换

</details>

<details>
<summary><b>数据管理</b></summary>

- 一键 JSON 导出/导入：全量历史 + 代码片段，图片 base64 内嵌，跨机器无损
- 合并导入策略：相同内容跳过，不覆盖现有历史
- 自动清理保留策略：1 / 7 / 30 / 90 天 / 永久；置顶和收藏的条目永不被清
- DB schema 版本化迁移：v0 → v1 加 `content_html` 列等

</details>

<details>
<summary><b>键盘流</b></summary>

| 快捷键 | 动作 |
|---|---|
| `Ctrl+Space` (可改) | 显示 / 隐藏主窗口 |
| `Ctrl+M` (可改) | 极简搜索 |
| 双击 `Ctrl` | 快速呼出（可关） |
| 双击卡片 / `Enter` | 复制（Enter 还会自动粘贴） |
| 单击卡片 | 仅选中（避免误触复制） |
| `↑/↓` `Tab` | 列表 / Tab 切换 |
| `ESC` | 分层返回 |
| `?` | 完整快捷键面板 |

</details>

---

## 隐私

- 数据**永不离开**你的机器
- OCR 在本地 CPU 跑，无云端
- 没账号、没遥测、没分析
- 敏感应用可配黑名单，源头阻断入库
- MIT 开源，欢迎审计

---

## 构建发行包

```bash
npm run tauri build
```

产物在 `src-tauri/target/release/bundle/nsis/` 下，含 `.exe` 安装包和 `.msi`。

### 前置依赖

- [Node.js](https://nodejs.org/) v18+
- [Rust](https://rustup.rs/) stable
- Visual Studio C++ Build Tools（Windows 编译 Rust 必需）
- [Everything](https://www.voidtools.com/) 后台运行（仅本机文件搜索功能需要）

---

## 技术栈

- **前端** — React 18 + TypeScript + Vite + TailwindCSS + DOMPurify
- **后端** — Rust + Tauri 1.5；rusqlite（bundled SQLite）+ WAL + mmap
- **AI** — ONNX Runtime（`ort` crate），RapidOCR 中英双语
- **Windows 深度整合** — 低级键盘钩子、`WM_CLIPBOARDUPDATE` 事件、`CF_HTML` 双写、Everything SDK 桥接

---

## 贡献

欢迎提 Issue / PR。功能建议、Bug 汇报、翻译都欢迎。

## 许可

MIT
