// Lightweight i18n system — no external dependencies

export type Locale = 'zh' | 'en';

const translations: Record<string, Record<Locale, string>> = {
    // ── App: Tabs ──
    'tab.all': { zh: '全部', en: 'All' },
    'tab.text': { zh: '文字', en: 'Text' },
    'tab.file': { zh: '文件', en: 'Files' },
    'tab.favorite': { zh: '收藏', en: 'Favorites' },
    'tab.image': { zh: '图片', en: 'Images' },
    'tab.link': { zh: '链接', en: 'Links' },
    'tab.code': { zh: '代码', en: 'Code' },

    // ── App: Time Groups ──
    'time.within_1h': { zh: '一小时内', en: 'Last hour' },
    'time.within_3h': { zh: '三小时内', en: 'Last 3 hours' },
    'time.today_morning': { zh: '今天上午', en: 'This morning' },
    'time.today_afternoon': { zh: '今天下午', en: 'This afternoon' },
    'time.today_evening': { zh: '今天晚上', en: 'This evening' },
    'time.yesterday': { zh: '昨天', en: 'Yesterday' },
    'time.last_7d': { zh: '近7天', en: 'Last 7 days' },
    'time.earlier': { zh: '更早', en: 'Earlier' },

    // ── App: Time Group Short Labels ──
    'time_short.within_1h': { zh: '1h', en: '1h' },
    'time_short.within_3h': { zh: '3h', en: '3h' },
    'time_short.today_morning': { zh: '早', en: 'AM' },
    'time_short.today_afternoon': { zh: '午', en: 'PM' },
    'time_short.today_evening': { zh: '晚', en: 'Eve' },
    'time_short.yesterday': { zh: '昨', en: 'Yst' },
    'time_short.last_7d': { zh: '7d', en: '7d' },
    'time_short.earlier': { zh: '前', en: 'Old' },

    // ── App: Search ──
    'search.placeholder': { zh: '搜索剪贴板...', en: 'Search clipboard...' },
    'search.no_match': { zh: '未找到匹配的记录', en: 'No matching results' },
    'search.no_filter_results': { zh: '当前筛选条件下没有记录', en: 'No records for current filter' },

    // ── App: Filter bar ──
    'filter.active': { zh: '筛选', en: 'Filters' },
    'filter.clear_all': { zh: '清除全部', en: 'Clear all' },

    // ── App: Welcome ──
    'welcome.title': { zh: '欢迎使用 Super Clip', en: 'Welcome to Super Clip' },
    'welcome.body': { zh: '复制任意内容即可开始记录。', en: 'Copy anything to get started.' },
    'welcome.shortcut_hint': { zh: '查看所有快捷键', en: 'View all shortcuts' },

    // ── App: Actions ──
    'action.copy': { zh: '直接复制', en: 'Copy' },
    'action.pin': { zh: '置顶', en: 'Pin' },
    'action.unpin': { zh: '取消置顶', en: 'Unpin' },
    'action.favorite': { zh: '收藏', en: 'Favorite' },
    'action.unfavorite': { zh: '取消收藏', en: 'Unfavorite' },
    'action.delete': { zh: '删除记录', en: 'Delete' },
    'action.float': { zh: '贴图到屏幕', en: 'Float to screen' },
    'action.copy_all': { zh: '复制全部', en: 'Copy all' },
    'action.copy_selected': { zh: '复制选中', en: 'Copy selected' },
    'action.cancel': { zh: '取消', en: 'Cancel' },
    'action.confirm_delete': { zh: '确定删除', en: 'Delete' },
    'action.confirm_clear': { zh: '确定清空', en: 'Clear all' },
    'action.ai_ocr': { zh: 'AI 识别', en: 'AI OCR' },

    // ── App: Multi-select ──
    'multi.toggle': { zh: '多选', en: 'Multi-select' },
    'multi.cancel': { zh: '取消', en: 'Cancel' },
    'multi.select_all': { zh: '全选', en: 'Select all' },
    'multi.deselect_all': { zh: '取消全选', en: 'Deselect all' },
    'multi.selected': { zh: '已选 {n} 项', en: '{n} selected' },
    'multi.merge_copy': { zh: '合并复制', en: 'Merge copy' },
    'multi.bulk_delete': { zh: '批量删除', en: 'Bulk delete' },
    'multi.deselect': { zh: '取消选择', en: 'Deselect' },
    'multi.confirm_delete': { zh: '确定删除选中的 {n} 条记录吗？', en: 'Delete {n} selected items?' },

    // ── App: Text operations ──
    'text.expand': { zh: '展开全文', en: 'Expand' },
    'text.collapse': { zh: '收起全文', en: 'Collapse' },
    'text.segment': { zh: '智能分词', en: 'Word split' },
    'text.exit_segment': { zh: '退出分词', en: 'Exit split' },
    'text.segments_selected': { zh: '已选中 {n} 个分词', en: '{n} words selected' },

    // ── App: Image preview ──
    'preview.image_badge': { zh: '图片 · 点击放大', en: 'Image · Click to enlarge' },
    'preview.file_badge': { zh: '文件 · 点击放大', en: 'File · Click to enlarge' },
    'preview.ocr_done': { zh: '提取完成：可直接在图片上滑动框选文字', en: 'Done — drag to select text on the image' },
    'preview.copy_all_ocr': { zh: '一键复制全部', en: 'Copy all text' },
    'preview.exit_hint': { zh: '按 ESC 或点击背景退出', en: 'Press ESC or click backdrop to exit' },

    // ── App: Toasts ──
    'toast.copied': { zh: '已复制到剪贴板', en: 'Copied to clipboard' },
    'toast.deleted': { zh: '已删除', en: 'Deleted' },
    'toast.undo': { zh: '撤销', en: 'Undo' },

    // ── App: Modals ──
    'modal.delete_title': { zh: '确认删除', en: 'Confirm delete' },
    'modal.delete_body': { zh: '此操作将永久删除该剪贴板记录，无法撤销。', en: 'This will permanently delete this clip.' },
    'modal.clear_title': { zh: '确定要清空历史吗？', en: 'Clear all history?' },
    'modal.clear_body': { zh: '此操作将永久删除所有历史记录，请谨慎操作。', en: 'This will permanently delete all history records.' },

    // ── App: Footer ──
    'footer.items': { zh: '{filtered} / {total} 条', en: '{filtered} / {total} items' },
    'footer.nav': { zh: '↑↓ 导航', en: '↑↓ Navigate' },
    'footer.click_copy': { zh: 'Click 复制', en: 'Click Copy' },
    'footer.enter_paste': { zh: 'Enter 粘贴', en: 'Enter Paste' },
    'footer.shortcuts': { zh: '? 快捷键', en: '? Shortcuts' },

    // ── App: Context menu ──
    'ctx.copy_selection': { zh: '复制选中文本', en: 'Copy selected text' },

    // ── App: Source filter ──
    'source.label': { zh: '来源:', en: 'Source:' },

    // ── App: Scroll nav ──
    'nav.scroll_top': { zh: '回到顶部', en: 'Scroll to top' },
    'nav.scroll_bottom': { zh: '滚到底部', en: 'Scroll to bottom' },

    // ── Shortcuts modal ──
    'shortcuts.title': { zh: '快捷键', en: 'Keyboard Shortcuts' },
    'shortcuts.close_hint': { zh: '按 ? 或 Esc 关闭', en: 'Press ? or Esc to close' },
    'shortcut.click': { zh: '复制到剪贴板', en: 'Copy to clipboard' },
    'shortcut.enter': { zh: '复制并粘贴', en: 'Copy & paste' },
    'shortcut.arrows': { zh: '上下导航', en: 'Navigate up/down' },
    'shortcut.space': { zh: '预览图片', en: 'Preview image' },
    'shortcut.esc': { zh: '返回上一层', en: 'Go back' },
    'shortcut.ctrl_c': { zh: '复制选中文本/条目', en: 'Copy selection/item' },
    'shortcut.ctrl_d': { zh: '切换仪表盘', en: 'Toggle dashboard' },
    'shortcut.ctrl_space': { zh: '打开/关闭主窗口', en: 'Toggle main window' },
    'shortcut.ctrl_m': { zh: '极简搜索模式', en: 'Spotlight search' },
    'shortcut.double_ctrl': { zh: '快速唤起', en: 'Quick launch' },
    'shortcut.question': { zh: '快捷键帮助', en: 'Shortcut help' },

    // ── Settings ──
    'settings.title': { zh: '设置', en: 'Settings' },
    'settings.close': { zh: '关闭设置', en: 'Close settings' },
    'settings.tab_general': { zh: '通用', en: 'General' },
    'settings.tab_snippets': { zh: '片段', en: 'Snippets' },
    'settings.saved': { zh: '设置已保存', en: 'Settings saved' },
    'settings.save_failed': { zh: '保存失败', en: 'Save failed' },
    'settings.cancel': { zh: '取消', en: 'Cancel' },
    'settings.save': { zh: '保存设置', en: 'Save' },

    'settings.hotkey': { zh: '全局呼出快捷键', en: 'Global shortcut' },
    'settings.hotkey_recording': { zh: '录制中...', en: 'Recording...' },
    'settings.hotkey_hint': { zh: '点击并按下新按键组合', en: 'Click and press new key combo' },
    'settings.hotkey_tip': { zh: '点击右侧按钮并按下新的按键组合进行录制。', en: 'Click the button and press a new key combination.' },

    'settings.mini_hotkey': { zh: '极简模式快捷键', en: 'Spotlight shortcut' },
    'settings.mini_hotkey_hint': { zh: '设定极简模式按键', en: 'Set spotlight mode key' },
    'settings.mini_hotkey_tip': { zh: '应用内按此快捷键切换极简搜索模式。默认 Ctrl+M。', en: 'Toggle spotlight search mode. Default: Ctrl+M.' },

    'settings.autostart': { zh: '开机自动启动', en: 'Launch at startup' },
    'settings.autostart_desc': { zh: '跟随系统启动时自动运行并在后台驻留', en: 'Auto-run on system startup and stay in the background' },

    'settings.intercept': { zh: '新剪贴板内容提示', en: 'New clip prompt' },
    'settings.intercept_desc': { zh: '开启时每次在外部 Ctrl+C 都会弹窗询问是否收录', en: 'When on, a prompt appears for each external copy' },

    'settings.double_ctrl': { zh: '双击 Ctrl 呼出窗口', en: 'Double-tap Ctrl to show' },
    'settings.double_ctrl_desc': { zh: '快速按下两次 Ctrl 键来显示或隐藏主窗口 (Windows)', en: 'Press Ctrl twice quickly to toggle the window (Windows)' },

    'settings.retention': { zh: '自动清理历史记录', en: 'Auto-clean history' },
    'settings.retention_tip': { zh: '置顶和收藏的内容永远不会被自动清理。', en: 'Pinned and favorited items are never auto-cleaned.' },
    'settings.retention_forever': { zh: '永久保留', en: 'Forever' },
    'settings.retention_1d': { zh: '1 天', en: '1 day' },
    'settings.retention_7d': { zh: '7 天', en: '7 days' },
    'settings.retention_30d': { zh: '30 天', en: '30 days' },
    'settings.retention_90d': { zh: '90 天', en: '90 days' },

    'settings.privacy': { zh: '隐私保护 — 忽略应用', en: 'Privacy — Ignored Apps' },
    'settings.privacy_desc': { zh: '以下应用的剪贴板内容不会被记录。', en: 'Clipboard content from these apps will not be recorded.' },
    'settings.privacy_placeholder': { zh: '如 KeePass.exe', en: 'e.g. KeePass.exe' },
    'settings.privacy_add': { zh: '添加', en: 'Add' },

    'settings.snippet_name': { zh: '片段名称', en: 'Snippet name' },
    'settings.snippet_content': { zh: '片段内容...', en: 'Snippet content...' },
    'settings.snippet_trigger': { zh: '触发前缀（可选，如 ;;email）', en: 'Trigger prefix (optional, e.g. ;;email)' },
    'settings.snippet_add': { zh: '添加片段', en: 'Add Snippet' },
    'settings.snippet_update': { zh: '更新片段', en: 'Update Snippet' },
    'settings.snippet_edit': { zh: '编辑', en: 'Edit' },
    'settings.snippet_del': { zh: '删除', en: 'Del' },

    // ── Dashboard ──
    'dash.analyzer': { zh: '分析面板', en: 'Analyzer' },
    'dash.title': { zh: '分类筛选', en: 'Filter' },
    'dash.back': { zh: '返回主界面', en: 'Back to main' },
    'dash.loading': { zh: '计算中...', en: 'Loading...' },
    'dash.reset': { zh: '重置', en: 'Reset' },
    'dash.reset_tooltip': { zh: '重置所有筛选', en: 'Reset all filters' },
    'dash.type_dist': { zh: '类别分布', en: 'Type distribution' },
    'dash.total': { zh: '总计', en: 'Total' },
    'dash.source_apps': { zh: '来源应用', en: 'Source Apps' },
    'dash.word_freq': { zh: '高频词统计', en: 'Top Keywords' },
    'dash.filter_tip_title': { zh: '筛选说明', en: 'Filter Info' },
    'dash.filter_tip_body': { zh: '点击上方模块将同时应用时间与分类类型过滤，主列表将即时更新。', en: 'Click modules above to apply time + type filters. The main list updates instantly.' },
    'dash.discovery': { zh: '智能发现', en: 'Smart Discovery' },
    'dash.settings': { zh: '设置', en: 'Settings' },
    'dash.clear': { zh: '清空', en: 'Clear' },

    'dash.range_30m': { zh: '30分钟', en: '30min' },
    'dash.range_2h': { zh: '2小时', en: '2h' },
    'dash.range_3h': { zh: '3小时', en: '3h' },
    'dash.range_1d': { zh: '一天', en: '1 day' },
    'dash.range_3d': { zh: '三天', en: '3 days' },
    'dash.range_all': { zh: '一直', en: 'All' },

    // ── MinimalistView ──
    'mini.placeholder': { zh: '搜索全部历史记录 或 文件…', en: 'Search all history or files...' },
    'mini.tab_switch': { zh: 'Tab 切换', en: 'Tab switch' },
    'mini.no_results': { zh: '没有匹配的结果', en: 'No matching results' },
    'mini.type_to_search': { zh: '输入关键词开始搜索', en: 'Type to search' },
    'mini.image_content': { zh: '图片内容', en: 'Image content' },
    'mini.just_now': { zh: '刚刚', en: 'Just now' },
    'mini.minutes_ago': { zh: '{n}分钟前', en: '{n}m ago' },
    'mini.hours_ago': { zh: '{n}小时前', en: '{n}h ago' },
    'mini.days_ago': { zh: '{n}天前', en: '{n}d ago' },
    'mini.open_file': { zh: '打开文件', en: 'Open file' },
    'mini.records': { zh: '{n} 条记录', en: '{n} records' },
    'mini.navigate': { zh: '导航', en: 'Navigate' },
    'mini.switch_cat': { zh: '切换分类', en: 'Switch category' },
    'mini.quick_select': { zh: '快选', en: 'Quick select' },
    'mini.execute': { zh: '执行', en: 'Execute' },
    'mini.cat_all': { zh: '全部', en: 'All' },
    'mini.cat_history': { zh: '剪贴板', en: 'Clipboard' },
    'mini.cat_everything': { zh: '本地文件', en: 'Local files' },
    'mini.cat_doc': { zh: '文档', en: 'Documents' },
    'mini.cat_image': { zh: '图片', en: 'Images' },
    'mini.cat_link': { zh: '链接', en: 'Links' },
    'mini.cat_code': { zh: '代码', en: 'Code' },
    'mini.cat_exe': { zh: '程序', en: 'Apps' },
    'mini.cat_folder': { zh: '文件夹', en: 'Folders' },

    // ── PromptModal ──
    'prompt.title': { zh: '发现新内容', en: 'New Content Detected' },
    'prompt.body': { zh: '检测到您刚复制的内容，是否将其收录到历史记录中？', en: 'New content detected. Save to history?' },
    'prompt.always': { zh: '是，以后默认收录', en: 'Always save' },
    'prompt.once': { zh: '仅本次', en: 'Just this once' },
    'prompt.ignore': { zh: '忽略', en: 'Ignore' },

    // ── FloatImage ──
    'float.aspect_ratio': { zh: '保持比例', en: 'Constrain ratio' },
    'float.stretch': { zh: '拉伸填充', en: 'Stretch to fill' },
    'float.ocr': { zh: '文字识别 (OCR)', en: 'Recognize Text (OCR)' },
    'float.close': { zh: '关闭', en: 'Close' },
    'float.copied': { zh: '复制成功', en: 'Copied!' },
    'float.copy_text': { zh: '复制文本', en: 'Copy text' },

    // ── Rich text badge ──
    'badge.rich_text': { zh: '富文本', en: 'RTF' },
    'badge.rich_text_tip': { zh: '此条目保留了原始格式（加粗/颜色/链接等），粘贴到支持富文本的应用会保留样式', en: 'This clip preserves the original formatting (bold/color/links). Pasting into a rich-text target keeps the styling.' },

    // ── Data management (Export / Import) ──
    'settings.data_management': { zh: '数据管理', en: 'Data Management' },
    'settings.data_management_desc': { zh: '导出所有剪贴板历史为 JSON 备份；或从备份文件合并导入（重复内容自动跳过）', en: 'Export full clipboard history as a JSON backup, or import (merge) from a backup — duplicates are automatically skipped.' },
    'settings.export': { zh: '导出为 JSON', en: 'Export to JSON' },
    'settings.exporting': { zh: '导出中…', en: 'Exporting…' },
    'settings.import': { zh: '从 JSON 导入', en: 'Import from JSON' },
    'settings.importing': { zh: '导入中…', en: 'Importing…' },
    'settings.export_success': { zh: '已导出 {count} 条记录（{size}）', en: 'Exported {count} clips ({size})' },
    'settings.import_confirm': { zh: '确认合并导入？相同内容的条目将自动跳过，不会覆盖现有历史。', en: 'Merge import? Duplicate entries will be skipped — existing history will not be overwritten.' },
    'settings.import_success': { zh: '新增 {added} 条，跳过 {skipped} 条，片段 {snippets} 条，错误 {errors}', en: 'Imported {added}, skipped {skipped}, snippets {snippets}, errors {errors}' },
};

// ── Runtime ──

let currentLocale: Locale = 'zh';

export function setLocale(locale: Locale) {
    currentLocale = locale;
    localStorage.setItem('locale', locale);
}

export function getLocale(): Locale {
    return currentLocale;
}

export function initLocale() {
    const saved = localStorage.getItem('locale') as Locale | null;
    currentLocale = saved || 'zh';
}

/**
 * Translate a key. Supports interpolation: t('multi.selected', { n: 3 })
 */
export function t(key: string, params?: Record<string, string | number>): string {
    const entry = translations[key];
    if (!entry) return key;
    let text = entry[currentLocale] || entry['zh'] || key;
    if (params) {
        for (const [k, v] of Object.entries(params)) {
            text = text.replace(`{${k}}`, String(v));
        }
    }
    return text;
}

/**
 * Get all keys for a given prefix (e.g., 'tab.' returns all tab translations)
 */
export function tGroup(prefix: string): Record<string, string> {
    const result: Record<string, string> = {};
    for (const key of Object.keys(translations)) {
        if (key.startsWith(prefix)) {
            result[key] = t(key);
        }
    }
    return result;
}
