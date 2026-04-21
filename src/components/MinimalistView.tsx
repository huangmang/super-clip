import React, { useRef, useEffect } from "react";
import {
    Search,
    CornerDownLeft,
    FileText,
    Link as LinkIcon,
    Code as CodeIcon,
    Image as ImageIcon,
    File as FileIcon,
    Zap,
    Clock,
    Package,
    Folder as FolderIcon,
} from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/tauri";
import { t } from "../i18n";

interface Clip {
    id: number;
    content: string;
    type: "text" | "image" | "file" | "link" | "code";
    is_favorite: boolean;
    is_pinned: boolean;
    created_at: string;
    source_app?: string | null;
    content_html?: string | null;
    is_file?: boolean;
    file_info?: {
        name: string;
        path: string;
        is_folder: boolean;
        size?: number;
    };
}

interface MinimalistViewProps {
    search: string;
    onSearchChange: (val: string) => void;
    results: any[];
    selectedIndex: number;
    onSelect: (index: number) => void;
    onCopy: (item: any, shouldPaste?: boolean) => void;
    onExit: () => void;
    fileCategory: string;
    setFileCategory: (cat: string) => void;
    theme?: "dark" | "light";
}

const CATEGORIES = [
    { id: "all",        i18nKey: "mini.cat_all",        icon: Zap },
    { id: "history",    i18nKey: "mini.cat_history",     icon: Clock },
    { id: "everything", i18nKey: "mini.cat_everything",  icon: Search },
    { id: "doc",        i18nKey: "mini.cat_doc",         icon: FileText },
    { id: "image",      i18nKey: "mini.cat_image",       icon: ImageIcon },
    { id: "link",       i18nKey: "mini.cat_link",        icon: LinkIcon },
    { id: "code",       i18nKey: "mini.cat_code",        icon: CodeIcon },
    { id: "exe",        i18nKey: "mini.cat_exe",         icon: Package },
    { id: "folder",     i18nKey: "mini.cat_folder",      icon: FolderIcon },
];

const TYPE_META: Record<string, { icon: React.ElementType; gradient: string; i18nKey: string }> = {
    text:   { icon: FileText,   gradient: "from-slate-500/20 to-slate-600/10", i18nKey: "tab.text" },
    image:  { icon: ImageIcon,  gradient: "from-rose-500/20 to-pink-600/10",  i18nKey: "tab.image" },
    link:   { icon: LinkIcon,   gradient: "from-sky-500/20 to-cyan-600/10",   i18nKey: "tab.link" },
    code:   { icon: CodeIcon,   gradient: "from-violet-500/20 to-purple-600/10", i18nKey: "tab.code" },
    file:   { icon: FileIcon,   gradient: "from-amber-500/20 to-orange-600/10",  i18nKey: "tab.file" },
    folder: { icon: FolderIcon, gradient: "from-amber-500/20 to-orange-600/10",  i18nKey: "mini.cat_folder" },
    exe:    { icon: Package,    gradient: "from-indigo-500/20 to-blue-600/10", i18nKey: "mini.cat_exe" },
};

const MinimalistView: React.FC<MinimalistViewProps> = ({
    search,
    onSearchChange,
    results,
    selectedIndex,
    onSelect,
    onCopy,
    onExit,
    fileCategory,
    setFileCategory,
    theme = "dark",
}) => {
    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    useEffect(() => {
        const item = listRef.current?.children[selectedIndex] as HTMLElement;
        item?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }, [selectedIndex]);

    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.preventDefault();
                onExit();
                return;
            }
            if (e.key === "ArrowDown") {
                e.preventDefault();
                onSelect(Math.min(selectedIndex + 1, results.length - 1));
            } else if (e.key === "ArrowUp") {
                e.preventDefault();
                onSelect(Math.max(selectedIndex - 1, 0));
            } else if (e.key === "Enter") {
                e.preventDefault();
                if (results[selectedIndex]) {
                    onCopy(results[selectedIndex], true);
                }
            }

            // Tab to cycle categories
            if (e.key === "Tab") {
                e.preventDefault();
                const currentIndex = CATEGORIES.findIndex(c => c.id === fileCategory);
                const nextIndex = (currentIndex + 1) % CATEGORIES.length;
                setFileCategory(CATEGORIES[nextIndex].id);
            }

            // Alt + 1-8 for quick paste (works even when search is focused)
            if (e.altKey && !e.ctrlKey && !e.metaKey) {
                const num = parseInt(e.key);
                if (num >= 1 && num <= 8) {
                    e.preventDefault();
                    const idx = num - 1;
                    if (results[idx]) {
                        onCopy(results[idx], true);
                    }
                }
            }
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [selectedIndex, results, onSelect, onCopy, onExit, fileCategory, setFileCategory]);

    const getPreview = (clip: Clip): string => {
        if (clip.type === "image") return t('mini.image_content');
        const text = clip.content.trim().replace(/\n/g, " ");
        return text.length > 72 ? text.slice(0, 72) + "…" : text;
    };

    const getTimeAgo = (dateStr: string): string => {
        const diff = Date.now() - new Date(dateStr).getTime();
        const mins = Math.floor(diff / 60000);
        if (mins < 1) return t('mini.just_now');
        if (mins < 60) return t('mini.minutes_ago', { n: mins });
        const hours = Math.floor(mins / 60);
        if (hours < 24) return t('mini.hours_ago', { n: hours });
        const days = Math.floor(hours / 24);
        return t('mini.days_ago', { n: days });
    };

    return (
        <div className="fixed inset-0 z-[200] flex flex-col"
            style={{
                background: theme === "dark" 
                    ? "linear-gradient(180deg, rgba(10,10,18,0.97) 0%, rgba(15,15,25,0.98) 100%)"
                    : "linear-gradient(180deg, rgba(242,242,247,0.8) 0%, rgba(242,242,247,0.85) 100%)",
                backdropFilter: theme === "dark" ? "blur(24px)" : "saturate(140%) blur(24px)",
                color: "var(--text-main)",
            }}
        >
            {/* ───── Search Bar & Filters ───── */}
            <div className="px-6 pt-6 pb-2">
                <div className="relative flex items-center mb-4 transition-all"
                    style={{
                        background: theme === "dark"
                            ? "linear-gradient(135deg, rgba(99,102,241,0.08) 0%, rgba(139,92,246,0.04) 100%)"
                            : "rgba(0,0,0,0.03)",
                        border: theme === "dark"
                            ? "1px solid rgba(99,102,241,0.15)"
                            : "1px solid rgba(0,0,0,0.05)",
                        borderRadius: "16px",
                        boxShadow: theme === "dark"
                            ? "0 8px 32px rgba(99,102,241,0.08), inset 0 1px 0 rgba(255,255,255,0.03)"
                            : "0 4px 12px rgba(0,0,0,0.02), inset 0 1px 2px rgba(0,0,0,0.02)",
                    }}
                >
                    <Search size={18} className="absolute left-5 text-indigo-400/70" />
                    <input
                        ref={inputRef}
                        type="text"
                        value={search}
                        onChange={(e) => onSearchChange(e.target.value)}
                        placeholder={t('mini.placeholder')}
                        className="w-full bg-transparent py-4 pl-13 pr-5 text-[15px] outline-none font-medium tracking-wide placeholder:opacity-30"
                        style={{ paddingLeft: "48px", color: "var(--text-main)" }}
                    />
                    <div className="absolute right-4 flex items-center gap-2">
                        <kbd className="px-2 py-0.5 rounded-md text-[9px] font-mono font-semibold opacity-30 border border-current"
                            style={{ background: "rgba(128,128,128,0.05)" }}>ESC</kbd>
                    </div>
                </div>

                {/* Category Filter Bar - Horizontal Scrollable */}
                <div className="flex items-center gap-2 overflow-x-auto pb-3 -mx-2 px-2 scrollbar-hide no-scrollbar"
                    style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}>
                    {CATEGORIES.map(cat => (
                        <button
                            onClick={() => setFileCategory(cat.id)}
                            key={cat.id}
                            className={`px-3 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${
                                fileCategory === cat.id 
                                ? "bg-blue-600 text-white shadow-lg shadow-blue-500/20 scale-105" 
                                : "bg-[var(--panel-bg)] text-[var(--text-dim)] hover:bg-[var(--panel-hover)] hover:text-blue-400"
                            }`}
                        >
                            <cat.icon size={12} className={fileCategory === cat.id ? "animate-pulse" : "group-hover:scale-110 transition-transform"} />
                            {t(cat.i18nKey)}
                        </button>
                    ))}
                    <div className="ml-auto sticky right-0 flex items-center pl-4 bg-gradient-to-l from-[var(--bg-color)] to-transparent pointer-events-none">
                        <div className="text-[10px] opacity-10 font-bold tracking-tight whitespace-nowrap">{t('mini.tab_switch')}</div>
                    </div>
                </div>
            </div>

            {/* ───── Results ───── */}
            <div ref={listRef} className="flex-1 overflow-y-auto px-4 pb-2 space-y-1"
                style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(99,102,241,0.2) transparent" }}>
                {results.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full gap-5">
                        <div className="w-16 h-16 rounded-2xl flex items-center justify-center"
                            style={{ background: "linear-gradient(135deg, rgba(99,102,241,0.1), rgba(139,92,246,0.05))", border: "1px solid rgba(99,102,241,0.1)" }}>
                            <Search size={24} className="text-indigo-500/40" />
                        </div>
                        <p className="text-white/20 text-sm font-medium">
                            {search ? t('mini.no_results') : t('mini.type_to_search')}
                        </p>
                    </div>
                ) : (
                    results.map((clip, index) => {
                        // Better type detection for icons
                        let displayType = clip.type;
                        if (clip.is_file || clip.type === "file") {
                            if (clip.file_info?.is_folder) {
                                displayType = "folder";
                            } else if (/\.(exe|lnk|msi)$/i.test(clip.content)) {
                                displayType = "exe";
                            } else if (/\.(pdf|doc|docx|xls|xlsx|ppt|pptx|txt|md|rtf|csv)$/i.test(clip.content)) {
                                displayType = "text"; // Show doc icon
                            } else if (/\.(png|jpg|jpeg|gif|bmp|webp|svg|ico)$/i.test(clip.content)) {
                                displayType = "image"; // Show image icon
                            } else {
                                displayType = "file";
                            }
                        }
                        
                        const meta = TYPE_META[displayType] || TYPE_META.text;
                        const isActive = index === selectedIndex;

                        return (
                            <div
                                key={clip.id}
                                onClick={() => onCopy(clip, true)}
                                onMouseEnter={() => onSelect(index)}
                                style={{
                                    background: isActive
                                        ? (theme === "dark" 
                                            ? "linear-gradient(135deg, rgba(99,102,241,0.12) 0%, rgba(139,92,246,0.06) 100%)"
                                            : "rgba(0, 113, 227, 0.05)")
                                        : "transparent",
                                    border: isActive
                                        ? (theme === "dark" ? "1px solid rgba(99,102,241,0.2)" : "1px solid rgba(0, 113, 227, 0.1)")
                                        : "1px solid transparent",
                                    borderRadius: "14px",
                                    transition: "all 0.2s cubic-bezier(0.4, 0, 0.2, 1)",
                                    transform: isActive ? "translateX(6px)" : "none",
                                    "--index": Math.min(index, 15)
                                } as React.CSSProperties}
                                className={`flex items-center gap-3.5 px-4 py-3 cursor-pointer group clip-entry glass ${isActive ? 'bg-blue-500/10' : ''}`}
                            >
                                {/* Number Badge */}
                                {index < 8 ? (
                                    <div
                                        className="w-7 h-7 rounded-lg flex items-center justify-center text-[11px] font-black shrink-0"
                                        style={{
                                            background: isActive
                                                ? "linear-gradient(135deg, #0071e3, #6366f1)"
                                                : "rgba(128,128,128,0.08)",
                                            color: isActive ? "#fff" : "var(--text-dim)",
                                            boxShadow: isActive ? "0 4px 12px rgba(0, 113, 227, 0.3)" : "none",
                                            border: isActive ? "none" : "1px solid var(--border-color)",
                                        }}
                                    >
                                        {index + 1}
                                    </div>
                                ) : (
                                    <div className="w-7 h-7 shrink-0" />
                                )}

                                {/* Type Icon */}
                                <div className="shrink-0">
                                    {clip.type === "image" ? (
                                        <div className="w-9 h-9 rounded-lg overflow-hidden"
                                            style={{ border: "1px solid rgba(255,255,255,0.06)", background: "rgba(0,0,0,0.3)" }}>
                                            <img
                                                src={convertFileSrc(clip.content)}
                                                className="w-full h-full object-cover"
                                                alt=""
                                            />
                                        </div>
                                    ) : (
                                        <div className={`w-8 h-8 rounded-lg flex items-center justify-center transition-all ${
                                        isActive ? 'bg-blue-600 text-white shadow-lg rotate-12' : 'bg-black/20 text-blue-400/50'
                                    }`}>
                                        <span className="text-xs font-black">{index + 1}</span>
                                    </div>
                                    )}
                                </div>

                                {/* Content */}
                                <div className="flex-1 min-w-0">
                                    <div className="text-[13px] truncate font-medium"
                                        style={{ color: isActive ? "var(--text-main)" : "var(--text-dim)" }}>
                                        {clip.is_file ? clip.file_info?.name : getPreview(clip)}
                                    </div>
                                    <div className="flex items-center gap-2.5 mt-1">
                                        <span className="text-[9px] font-bold uppercase tracking-[0.1em] px-1.5 py-0.5 rounded"
                                            style={{
                                                color: isActive ? "var(--accent-color)" : "var(--text-dim)",
                                                background: isActive ? "var(--panel-hover)" : "var(--input-bg)",
                                                opacity: isActive ? 1 : 0.6
                                            }}>
                                            {clip.is_file 
                                                ? (clip.file_info?.is_folder ? "文件夹" : (displayType === "exe" ? "程序" : "文件")) 
                                                : t(meta.i18nKey)
                                            }
                                        </span>
                                        {clip.is_file ? (
                                             <span className="text-[9px] truncate"
                                             style={{ color: "rgba(255,255,255,0.18)" }}>
                                             {clip.file_info?.path}
                                         </span>
                                        ) : (
                                            <>
                                                {clip.source_app && (
                                                    <span className="text-[9px] flex items-center gap-1"
                                                        style={{ color: "rgba(255,255,255,0.18)" }}>
                                                        <span className="w-1 h-1 rounded-full inline-block"
                                                            style={{ background: isActive ? "#818cf8" : "rgba(255,255,255,0.15)" }} />
                                                        {clip.source_app}
                                                    </span>
                                                )}
                                                <span className="text-[9px]"
                                                    style={{ color: "var(--text-dim)", opacity: 0.5 }}>
                                                    {getTimeAgo(clip.created_at)}
                                                </span>
                                            </>
                                        )}
                                    </div>
                                </div>

                                {/* Action Hint */}
                                {isActive && (
                                    <div className="flex items-center gap-2 shrink-0 px-3 py-1.5 rounded-lg bg-indigo-500/10 border border-indigo-500/20"
                                        style={{ animation: "fadeSlideIn 0.2s ease-out" }}>
                                        {clip.is_file ? (
                                            <>
                                                <span className="text-[10px] font-bold text-indigo-500">{t('mini.open_file')}</span>
                                                <CornerDownLeft size={10} className="text-indigo-600" />
                                            </>
                                        ) : (
                                            <CornerDownLeft size={11} className="text-indigo-600" />
                                        )}
                                    </div>
                                )}
                            </div>
                        );
                    })
                )}
            </div>

            {/* ───── Footer ───── */}
            <div className="px-6 py-3 flex items-center justify-between"
                style={{
                    borderTop: "1px solid var(--border-color)",
                    background: theme === "dark" ? "rgba(8,8,15,0.6)" : "rgba(242,242,247,0.5)",
                }}>
                <div className="flex items-center gap-5">
                    {[
                        { keys: "↑↓", label: t('mini.navigate') },
                        { keys: "Tab", label: t('mini.switch_cat') },
                        { keys: "Alt+1~8", label: t('mini.quick_select') },
                        { keys: "Enter", label: t('mini.execute') },
                    ].map(item => (
                        <span key={item.keys} className="flex items-center gap-1.5 text-[9px] font-semibold"
                            style={{ color: "var(--text-dim)", opacity: 0.6 }}>
                            <kbd className="px-1.5 py-0.5 rounded font-mono text-[8px]"
                                style={{ background: "var(--input-bg)", border: "1px solid var(--border-color)" }}>
                                {item.keys}
                            </kbd>
                            {item.label}
                        </span>
                    ))}
                </div>
                <div className="flex items-center gap-1.5 text-[9px] font-semibold"
                    style={{ color: "var(--text-dim)", opacity: 0.6 }}>
                    <Zap size={9} />
                    {t('mini.records', { n: results.length })}
                </div>
            </div>
        </div>
    );
};

export default MinimalistView;

