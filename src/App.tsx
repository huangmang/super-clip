import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { OcrResult } from "./components/OCRLayer";
import ImageOcrViewer from "./components/ImageOcrViewer";
import { invoke } from "@tauri-apps/api/tauri";
import { listen } from "@tauri-apps/api/event";
import { convertFileSrc } from "@tauri-apps/api/tauri";
import { t, initLocale } from "./i18n";
import { appWindow, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/window";
import {
    Copy,
    Trash2,
    Image as ImageIcon,
    FileText,
    Link as LinkIcon,
    Code as CodeIcon,
    Star,
    Settings as SettingsIcon,
    AlertCircle,
    Pin,
    Eraser,
    Maximize2,
    CheckSquare,
    X,
    Square,
    ScanSearch,
    Minus,
    Moon,
    Sun,
    ChevronUp,
    ChevronDown
} from "lucide-react";
import Settings from "./components/Settings";
import Dashboard from "./components/Dashboard";
import MinimalistView from "./components/MinimalistView";
import { LayoutDashboard } from "lucide-react";
import Tooltip from "./components/Tooltip";
import LazyCodeBlock from './components/LazyCodeBlock';
import Onboarding, { shouldShowOnboarding } from './components/Onboarding';
import DOMPurify from 'dompurify';

// Belt-and-suspenders: drop ANY attribute whose name begins with `on`.
// The default HTML profile already strips known event handlers, but a
// blanket hook is resilient to new handler names (`onbeforeinput`,
// `onpointerrawupdate`, etc.) and to any future config drift in our
// explicit FORBID_ATTR list.
DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
    if (data.attrName && data.attrName.toLowerCase().startsWith('on')) {
        data.keepAttr = false;
    }
});

const sanitizeHtml = (html: string): string => {
    try {
        return DOMPurify.sanitize(html, {
            USE_PROFILES: { html: true },
            FORBID_TAGS: ['style', 'link', 'script', 'iframe', 'object', 'embed', 'form', 'input', 'button'],
            // Explicit list kept as defence-in-depth alongside the on* hook above.
            FORBID_ATTR: ['srcset', 'autofocus', 'formaction'],
        });
    } catch {
        return '';
    }
};

// Returns a stable group key, NOT a localized string. Render with t('time.' + key).
// Stable keys also let NAV_SHORT_LABELS index reliably across locales.
type GroupKey =
    | 'within_1h' | 'within_3h'
    | 'today_morning' | 'today_afternoon' | 'today_evening'
    | 'yesterday' | 'last_7d' | 'earlier';

const getGroupKey = (dateStr: string): GroupKey => {
    const d = new Date(dateStr);
    const now = new Date();
    // Use midnight-anchored date diff so a 23:30→00:30 jump puts the older
    // entry into "yesterday", not "last_7d" via floor(diff/24h)==0.
    const dMidnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const nowMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const dayDiff = Math.round((nowMidnight - dMidnight) / (24 * 60 * 60 * 1000));

    const diffMs = now.getTime() - d.getTime();

    if (dayDiff === 0) {
        if (diffMs < 60 * 60 * 1000) return 'within_1h';
        if (diffMs < 3 * 60 * 60 * 1000) return 'within_3h';
        const hour = d.getHours();
        if (hour < 12) return 'today_morning';
        if (hour < 18) return 'today_afternoon';
        return 'today_evening';
    }
    if (dayDiff === 1) return 'yesterday';
    if (dayDiff <= 7) return 'last_7d';
    return 'earlier';
};

const NAV_SHORT_LABELS: Record<GroupKey, string> = {
    within_1h: '1h',
    within_3h: '3h',
    today_morning: '早',
    today_afternoon: '午',
    today_evening: '晚',
    yesterday: '昨',
    last_7d: '7d',
    earlier: '前',
};

const detectLanguage = (text: string): string => {
    const lower = text.toLowerCase().trim();

    // 1. High Priority / Very Unique Tags
    if (lower.includes('<?php')) return 'php';
    if (lower.includes('<html>') || lower.includes('</div>') || lower.includes('</body>')) return 'html';

    // 2. Rust specific (Precede JS because they share 'let' and '=>')
    if (lower.includes('fn ') || lower.includes('pub fn ') || lower.includes('use ') ||
        lower.includes('impl ') || lower.includes('trait ') || lower.includes('mod ') ||
        lower.includes('println!') || lower.includes('vec!') || lower.includes('let mut ') ||
        lower.includes('#[derive(') || (lower.includes('match ') && lower.includes(' => '))) return 'rust';

    // 3. Scripting / Types
    if (lower.includes('import ') || lower.includes('export ') || lower.includes('const ') ||
        lower.includes('let ') || lower.includes('=>') || lower.includes('console.log')) return 'javascript';

    // 4. Other languages
    if (lower.includes('def ') && lower.includes(':')) return 'python';
    if (lower.includes('public class ') || (lower.includes('private ') && lower.includes('{'))) return 'java';
    if (lower.includes('func ') && lower.includes('{')) return 'go';
    if (lower.includes('package ') && lower.includes('import (')) return 'go';
    if (lower.includes('#include <') || lower.includes('int main(')) return 'cpp';
    if (lower.includes('select ') && lower.includes('from ')) return 'sql';
    if (lower.includes('.css {') || lower.includes('display: ') || lower.includes('color: ')) return 'css';
    if (lower.startsWith('{') || lower.startsWith('[') || (lower.includes(':') && lower.includes('"'))) return 'json';

    return 'javascript';
};

interface Clip {
    id: number;
    content: string;
    type: "text" | "image" | "file" | "link" | "code";
    is_favorite: boolean;
    is_pinned: boolean;
    created_at: string;
    ocr_text?: string | null;
    ocr_lines?: string | null;
    source_app?: string | null;
    content_html?: string | null;
}

// Extracted to top-level to avoid re-creation on every render
const HighlightText = React.memo(({ text, highlight }: { text: string; highlight: string }) => {
    if (!highlight.trim()) return <>{text}</>;
    try {
        const parts = text.split(new RegExp(`(${highlight.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, "gi"));
        return (
            <>
                {parts.map((part, i) =>
                    part.toLowerCase() === highlight.toLowerCase() ? (
                        <span key={i} className="bg-indigo-500/30 text-indigo-500 rounded px-0.5">{part}</span>
                    ) : (
                        part
                    )
                )}
            </>
        );
    } catch {
        return <>{text}</>;
    }
});

interface ClipPage {
    items: Clip[];
    total: number;
    has_more: boolean;
}

const PAGE_SIZE = 100;

const TAB_DEFS = [
    { id: "all", key: "tab.all", icon: null },
    { id: "text", key: "tab.text", icon: FileText },
    { id: "file", key: "tab.file", icon: FileText },
    { id: "favorite", key: "tab.favorite", icon: Star },
    { id: "image", key: "tab.image", icon: ImageIcon },
    { id: "link", key: "tab.link", icon: LinkIcon },
    { id: "code", key: "tab.code", icon: CodeIcon },
];

// Initialize locale from localStorage on module load
initLocale();

function App() {
    const [clips, setClips] = useState<Clip[]>([]);
    const [activeTab, setActiveTab] = useState("all");
    const [search, setSearch] = useState("");
    const [debouncedSearch, setDebouncedSearch] = useState("");
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [previewImage, setPreviewImage] = useState<string | null>(null);
    const [ocrData, setOcrData] = useState<OcrResult | null>(null);
    const [ocrLoading, setOcrLoading] = useState(false);
    // Multi-select / hint state is now owned inside <ImageOcrViewer>; the
    // modal-level references below are kept only as compatibility no-ops so
    // the existing Ctrl+C / Escape handlers below don't need surgery. The
    // viewer intercepts those keys in capture phase before they reach here.
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    // Per-card delete uses optimistic remove + 3s undo (Gmail-style),
    // no per-row confirm modal. Bulk delete is destructive over many rows
    // so it gets its own explicit confirm modal.
    const [isBulkDeleteConfirmOpen, setIsBulkDeleteConfirmOpen] = useState(false);
    const [isClearConfirmOpen, setIsClearConfirmOpen] = useState(false);
    // Everything SDK availability — null = unknown / never tried; "ok" = working;
    // "not_installed" / "not_running" → minimalist view shows a remediation hint.
    const [everythingStatus, setEverythingStatus] = useState<"ok" | "not_installed" | "not_running" | null>(null);
    const [showOnboarding, setShowOnboarding] = useState<boolean>(() => shouldShowOnboarding());
    const [copyFeedback, setCopyFeedback] = useState(false);
    const [copyConfirmClip, setCopyConfirmClip] = useState<{clip: Clip, shouldPaste: boolean} | null>(null);
    const [isDashboard, setIsDashboard] = useState(true);
    const [isMultiSelect, setIsMultiSelect] = useState(false);
    const [selectedIds, setSelectedIds] = useState<number[]>([]);
    
    const [lastSelectedId, setLastSelectedId] = useState<number | null>(null);
    const [sourceAppFilter, setSourceAppFilter] = useState<string | null>(null);
    const [expandedClips, setExpandedClips] = useState<number[]>([]); // Track expanded text clips
    const [segmentingClips, setSegmentingClips] = useState<number[]>([]); // Track clips in word-segmentation mode
    const [timeFilter, setTimeFilter] = useState<string | null>('1d'); // null, '30m', '2h', '1d', '3d'
    const [isMinimalist, setIsMinimalist] = useState(false);
    const [miniSearch, setMiniSearch] = useState("");
    const [miniSelectedIndex, setMiniSelectedIndex] = useState(0);

    // Word segment selection states
    const [selectedSegments, setSelectedSegments] = useState<Record<number, number[]>>({}); // clipId -> segmentIndices[]
    const [everythingFiles, setEverythingFiles] = useState<any[]>([]);
    const [fileCategory, setFileCategory] = useState<string>("all"); // "all", "doc", "image", "exe", "folder"
    const [hasMore, setHasMore] = useState(true);
    const sentinelRef = useRef<HTMLDivElement>(null);


    const isDraggingSegmentsRef = useRef(false);
    const wasDraggingSegmentsRef = useRef(false);
    const segmentDragStartIdx = useRef<number | null>(null);
    const segmentDragActiveId = useRef<number | null>(null);
    // `themePref` is the user's preference: dark / light / auto (auto = follow OS).
    // `theme` is the resolved value used for rendering ("dark" or "light"); when
    // pref is auto we recompute it from `prefers-color-scheme` and react to OS changes.
    const [themePref, setThemePref] = useState<'dark' | 'light' | 'auto'>('dark');
    const [theme, setTheme] = useState<'dark' | 'light'>('dark');
    const [entities, setEntities] = useState<{ entity_type: string; value: string; display: string }[]>([]);
    const [showShortcuts, setShowShortcuts] = useState(false);

    const applyTheme = (resolved: 'dark' | 'light') => {
        setTheme(resolved);
        if (resolved === 'light') {
            document.documentElement.classList.add("light");
        } else {
            document.documentElement.classList.remove("light");
        }
    };

    // Load theme preference, resolve, and subscribe to OS change when on `auto`.
    useEffect(() => {
        const initTheme = async () => {
            const saved = localStorage.getItem("theme");
            const dbTheme = await invoke("get_setting", { key: "theme" }).catch(() => null);
            const pref = ((dbTheme || saved || 'dark') as 'dark' | 'light' | 'auto');
            setThemePref(pref);
            if (pref === 'auto') {
                const mql = window.matchMedia('(prefers-color-scheme: dark)');
                applyTheme(mql.matches ? 'dark' : 'light');
            } else {
                applyTheme(pref);
            }
        };
        initTheme();
    }, []);

    // When in `auto` mode, react live to OS theme changes (e.g. user flips
    // Windows Settings → Personalization → Colors).
    useEffect(() => {
        if (themePref !== 'auto') return;
        const mql = window.matchMedia('(prefers-color-scheme: dark)');
        const handler = (e: MediaQueryListEvent) => applyTheme(e.matches ? 'dark' : 'light');
        mql.addEventListener('change', handler);
        // Sync once on mount in case OS changed between init and effect attach.
        applyTheme(mql.matches ? 'dark' : 'light');
        return () => mql.removeEventListener('change', handler);
    }, [themePref]);

    // ── Window position / size memory ──
    // Persist in localStorage on resize/move (debounced) and restore on mount.
    // Skipped when the saved geometry would land off-screen (monitor changed).
    useEffect(() => {
        const STORAGE_KEY = "super-clip:window-geometry";
        let restored = false;

        const restore = async () => {
            try {
                const raw = localStorage.getItem(STORAGE_KEY);
                if (!raw) return;
                const g = JSON.parse(raw) as { x: number; y: number; w: number; h: number };
                if (
                    typeof g.x !== "number" || typeof g.y !== "number" ||
                    typeof g.w !== "number" || typeof g.h !== "number" ||
                    g.w < 320 || g.h < 240
                ) return;
                // Best-effort sanity check: visible portion of any monitor.
                // Negative coords are valid for multi-monitor setups so we don't reject them.
                if (Math.abs(g.x) > 30000 || Math.abs(g.y) > 30000) return;
                await appWindow.setPosition(new PhysicalPosition(g.x, g.y));
                await appWindow.setSize(new PhysicalSize(g.w, g.h));
            } catch {
                // ignore — corrupt storage just falls back to default geometry
            } finally {
                restored = true;
            }
        };
        restore();

        let saveTimer: ReturnType<typeof setTimeout> | null = null;
        const schedSave = async () => {
            if (!restored) return;
            if (saveTimer) clearTimeout(saveTimer);
            saveTimer = setTimeout(async () => {
                try {
                    const pos = await appWindow.outerPosition();
                    const size = await appWindow.outerSize();
                    localStorage.setItem(STORAGE_KEY, JSON.stringify({
                        x: pos.x, y: pos.y, w: size.width, h: size.height,
                    }));
                } catch { /* noop */ }
            }, 500);
        };

        const unMoved = appWindow.onMoved(schedSave);
        const unResized = appWindow.onResized(schedSave);
        return () => {
            if (saveTimer) clearTimeout(saveTimer);
            unMoved.then(f => f());
            unResized.then(f => f());
        };
    }, []);

    const toggleTheme = () => {
        // Cycle: dark → light → auto → dark
        const nextPref: 'dark' | 'light' | 'auto' =
            themePref === 'dark' ? 'light' :
            themePref === 'light' ? 'auto' : 'dark';
        setThemePref(nextPref);
        if (nextPref === 'auto') {
            const mql = window.matchMedia('(prefers-color-scheme: dark)');
            applyTheme(mql.matches ? 'dark' : 'light');
        } else {
            applyTheme(nextPref);
        }
        localStorage.setItem("theme", nextPref);
        invoke("save_setting", { key: "theme", value: nextPref }).catch(console.error);
    };


    const [fuzzyResults, setFuzzyResults] = useState<Clip[]>([]);
    const [snippetResults, setSnippetResults] = useState<any[]>([]);

    // Search with fuzzy matching + Everything files when minimalist search changes
    useEffect(() => {
        if (!isMinimalist) return;

        const timer = setTimeout(() => {
            // Fuzzy search clips (includes OCR text in haystack)
            if (fileCategory !== "everything") {
                invoke<Clip[]>("fuzzy_search_clips", { query: miniSearch, limit: 50 })
                    .then(setFuzzyResults)
                    .catch(() => setFuzzyResults([]));

                // Also search snippets
                invoke<any[]>("get_snippets")
                    .then(snips => {
                        if (!miniSearch.trim()) { setSnippetResults(snips); return; }
                        const q = miniSearch.toLowerCase();
                        setSnippetResults(snips.filter((s: any) =>
                            s.name.toLowerCase().includes(q) ||
                            s.content.toLowerCase().includes(q) ||
                            (s.trigger_text && s.trigger_text.toLowerCase().includes(q))
                        ));
                    })
                    .catch(() => setSnippetResults([]));
            }

            // Everything file search
            let shouldSearchEverything = false;
            let query = miniSearch;

            if (fileCategory === "all" || fileCategory === "everything") {
                if (miniSearch.trim()) shouldSearchEverything = true;
            } else if (["doc", "image", "exe", "folder"].includes(fileCategory)) {
                query = `${fileCategory}: ${miniSearch}`;
                shouldSearchEverything = true;
            }

            if (shouldSearchEverything) {
                invoke<any[]>("search_files", { query })
                    .then(files => {
                        setEverythingFiles(files);
                        setEverythingStatus("ok");
                    })
                    .catch(err => {
                        setEverythingFiles([]);
                        const msg = String(err);
                        if (msg.includes("EVERYTHING_NOT_INSTALLED")) setEverythingStatus("not_installed");
                        else if (msg.includes("EVERYTHING_NOT_RUNNING")) setEverythingStatus("not_running");
                        // Other errors: leave status as-is (don't downgrade a working state on a transient hiccup)
                    });
            } else {
                setEverythingFiles([]);
            }
        }, 150);

        return () => clearTimeout(timer);
    }, [miniSearch, isMinimalist, fileCategory]);

    const [contextMenu, setContextMenu] = useState<{ x: number, y: number, text: string } | null>(null);

    // Use a ref to make filteredClips accessible in the keyboard effect without forward-reference
    const filteredClipsRef = useRef<Clip[]>([]);

    useEffect(() => {
        if (previewImage) {
            setOcrData(null);
            const clip = clips.find(c => c.content === previewImage);
            if (clip) {
                invoke("perform_ocr", { id: clip.id, path: clip.content })
                    .then((res) => setOcrData(res as OcrResult))
                    .catch(console.error);
            }
        }
    }, [previewImage, clips]);

    // (multi-select + hint state now live inside <ImageOcrViewer>; nothing to sync here)

    const loadClips = useCallback(async (reset = true) => {
        try {
            if (reset) {
                // Load all clips to ensure filters work correctly across the full dataset
                const allClips = await invoke<Clip[]>("get_clips");
                setClips(allClips);
                setHasMore(false);
            } else {
                const offset = clips.length;
                const page = await invoke<ClipPage>("get_clips_page", { limit: PAGE_SIZE, offset });
                setClips(prev => [...prev, ...page.items]);
                setHasMore(page.has_more);
            }
        } catch (error) {
            console.error("Failed to load clips:", error);
        }
    }, [clips.length]);

    // Debounce search input to avoid re-filtering on every keystroke
    useEffect(() => {
        const timer = setTimeout(() => setDebouncedSearch(search), 150);
        return () => clearTimeout(timer);
    }, [search]);

    // Extract entities for selected clip
    useEffect(() => {
        const clip = filteredClipsRef.current[selectedIndex];
        if (clip && clip.type !== "image") {
            const timer = setTimeout(() => {
                invoke<{ entity_type: string; value: string; display: string }[]>("extract_entities", { content: clip.content })
                    .then(setEntities)
                    .catch(() => setEntities([]));
            }, 200);
            return () => clearTimeout(timer);
        } else {
            setEntities([]);
        }
    }, [selectedIndex, clips]);

    // Use ref for isMinimalist so event listeners don't need to re-register
    const isMinimalistRef = useRef(isMinimalist);
    useEffect(() => { isMinimalistRef.current = isMinimalist; }, [isMinimalist]);

    useEffect(() => {
        loadClips();
        const unlistenNewClip = listen("clip:created", () => {
            loadClips();
        });

        const unlistenShowMode = listen<string>("window:show-mode", (event) => {
            if (event.payload === "minimalist") {
                setIsMinimalist(true);
                setMiniSearch("");
                setMiniSelectedIndex(0);
            } else {
                setIsMinimalist(false);
            }
            appWindow.show();
            appWindow.setFocus();
        });

        const unlistenHotkeyTrigger = listen<string>("window:hotkey-trigger", (event) => {
            const targetIsMinimalist = event.payload === "minimalist";
            if (isMinimalistRef.current === targetIsMinimalist) {
                appWindow.hide();
            } else {
                if (targetIsMinimalist) {
                    setIsMinimalist(true);
                    setMiniSearch("");
                    setMiniSelectedIndex(0);
                } else {
                    setIsMinimalist(false);
                }
                appWindow.show();
                appWindow.setFocus();
            }
        });

        return () => {
            unlistenNewClip.then((f) => f());
            unlistenShowMode.then((f) => f());
            unlistenHotkeyTrigger.then((f) => f());
        };
    }, []); // Now stable — no deps needed thanks to useRef

    const executeCopy = useCallback(async (clip: Clip, shouldPaste: boolean = false) => {
        try {
            await invoke("copy_to_clipboard", { content: clip.content, kind: clip.type, contentHtml: clip.content_html ?? null });
            setCopyFeedback(true);
            setTimeout(() => setCopyFeedback(false), 1500);

            if (shouldPaste) {
                // uTools style: hide window and simulate Ctrl+V
                await invoke("hide_window"); // Assuming this command exists or we need to add it, or use appWindow.hide()
                // Wait a tiny bit for window to hide and focus to return to previous app
                setTimeout(async () => {
                    await invoke("simulate_v_key");
                }, 100);
            }
        } catch (error) {
            console.error("[DEBUG] Failed to copy in executeCopy:", error);
        }
    }, [setCopyFeedback]);

    const handleCopy = useCallback(async (clip: Clip, shouldPaste: boolean = false) => {
        await executeCopy(clip, shouldPaste);
    }, [executeCopy]);

    const toggleSelect = (id: number, shiftKey: boolean = false) => {
        if (shiftKey && lastSelectedId !== null && isMultiSelect) {
            const currentIndex = filteredClips.findIndex(c => c.id === id);
            const lastIndex = filteredClips.findIndex(c => c.id === lastSelectedId);
            if (currentIndex !== -1 && lastIndex !== -1) {
                const start = Math.min(currentIndex, lastIndex);
                const end = Math.max(currentIndex, lastIndex);
                const idsInRange = filteredClips.slice(start, end + 1).map(c => c.id);

                setSelectedIds(prev => {
                    const newIds = [...prev];
                    idsInRange.forEach(rangeId => {
                        if (!newIds.includes(rangeId)) newIds.push(rangeId);
                    });
                    return newIds;
                });
                setLastSelectedId(id);
                return;
            }
        }

        setSelectedIds(prev =>
            prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]
        );
        setLastSelectedId(id);
    };

    const handleSelectAll = () => {
        if (selectedIds.length === filteredClips.length && filteredClips.length > 0) {
            setSelectedIds([]);
        } else {
            setSelectedIds(filteredClips.map(c => c.id));
        }
    };

    const handleBulkCopy = async () => {
        const selectedClips = clips.filter(c => selectedIds.includes(c.id));
        const mergedText = selectedClips
            .filter(c => c.type !== 'image')
            .map(c => c.content)
            .join("\n---\n");

        if (mergedText) {
            await invoke("copy_to_clipboard", { content: mergedText, kind: "text" });
            setCopyFeedback(true);
            setTimeout(() => setCopyFeedback(false), 1500);
            setIsMultiSelect(false);
            setSelectedIds([]);
        }
    };

    const handleBulkDelete = () => {
        // Open the in-app confirm modal instead of native window.confirm —
        // keeps the visual style consistent with single-clip / clear-all
        // confirms and stays themable in dark/light.
        setIsBulkDeleteConfirmOpen(true);
    };

    const performBulkDelete = async () => {
        await invoke("batch_delete_clips", { ids: selectedIds });
        setSelectedIds([]);
        setIsMultiSelect(false);
        setIsBulkDeleteConfirmOpen(false);
        loadClips();
    };

    // Keyboard event handler
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            // "?" to toggle keyboard shortcuts help
            if (e.key === "?" && document.activeElement?.tagName !== "INPUT" && document.activeElement?.tagName !== "TEXTAREA") {
                setShowShortcuts(prev => !prev);
                return;
            }

            // ESC — layered dismiss (highest priority first)
            if (e.key === "Escape") {
                // 0. Close shortcuts help
                if (showShortcuts) { setShowShortcuts(false); return; }
                // 1. Close image preview (ImageOcrViewer intercepts Esc for its
                // own layered dismissals — multi-select → search → close — via
                // a capture-phase listener, so by the time it reaches here the
                // viewer is ready to be torn down).
                if (previewImage) { setPreviewImage(null); setOcrData(null); return; }
                // 2. Close settings modal
                if (isSettingsOpen) { setIsSettingsOpen(false); return; }
                // 3. Close delete/clear/copy confirm dialogs
                if (isBulkDeleteConfirmOpen) { setIsBulkDeleteConfirmOpen(false); return; }
                if (isClearConfirmOpen) { setIsClearConfirmOpen(false); return; }
                if (copyConfirmClip) { setCopyConfirmClip(null); return; }
                // 4. Exit minimalist mode
                if (isMinimalist) { setIsMinimalist(false); return; }
                // 5. Exit multi-select
                if (isMultiSelect) { setIsMultiSelect(false); setSelectedIds([]); return; }
                // 6. Clear source app filter
                if (sourceAppFilter) { setSourceAppFilter(null); return; }
                // 7. Clear search
                if (search) { setSearch(""); setDebouncedSearch(""); return; }
                // 8. Reset tab to "all"
                if (activeTab !== "all") { setActiveTab("all"); return; }
                // 9. Nothing to dismiss — hide window
                invoke("hide_window");
                return;
            }

            // If user is currently typing in the search box, skip global shortcuts
            // BUT allow modifier combos (Ctrl+C, etc.) to pass through
            if (document.activeElement?.tagName === "INPUT" && (e.key !== "Enter" && e.key !== "ArrowDown" && e.key !== "ArrowUp")) {
                if (!(e.ctrlKey || e.metaKey || e.altKey)) {
                    return;
                }
            }

            // Unified Ctrl+C handling
            if ((e.ctrlKey || e.metaKey) && (e.code === "KeyC" || e.key.toLowerCase() === "c")) {
                // Viewer intercepts Ctrl+C in capture phase when a multi-select
                // exists; by the time we see it here, nothing in-viewer owns it.
                const selection = window.getSelection();
                const selectedText = selection ? selection.toString() : "";

                if (selectedText.length > 0) {
                    e.preventDefault();
                    handleCopy({ content: selectedText, type: "text" } as Clip);
                    return;
                }

                if (selectedIndex >= 0 && filteredClipsRef.current[selectedIndex]) {
                    e.preventDefault();
                    handleCopy(filteredClipsRef.current[selectedIndex]);
                    return;
                }
            }

            // Arrow keys navigation
            if (e.key === "ArrowDown") {
                e.preventDefault();
                setSelectedIndex((prev) => Math.min(prev + 1, filteredClipsRef.current.length - 1));
            } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSelectedIndex((prev) => Math.max(prev - 1, 0));
            } else if (e.key === "Enter") {
                // Enter to copy and paste (uTools style)
                e.preventDefault();
                if (filteredClipsRef.current[selectedIndex]) {
                    handleCopy(filteredClipsRef.current[selectedIndex], true);
                }
            } else if (e.key === " ") {
                // Spacebar Quick Preview
                e.preventDefault();
                const selectedItem = filteredClipsRef.current[selectedIndex];
                if (selectedItem && (selectedItem.type === "image" || (selectedItem.type === "file" && /\.(png|jpg|jpeg|gif|bmp|webp|svg|ico)$/i.test(selectedItem.content)))) {
                    setPreviewImage(selectedItem.content);
                } else if (previewImage) {
                    setPreviewImage(null);
                }
            } else if ((e.ctrlKey || e.metaKey) && e.code === "KeyD") {
                // Ctrl+D to toggle dashboard
                e.preventDefault();
                setIsDashboard(prev => !prev);
            }
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [selectedIndex, previewImage, handleCopy, isSettingsOpen, isBulkDeleteConfirmOpen, isClearConfirmOpen, copyConfirmClip, isMinimalist, isMultiSelect, sourceAppFilter, search, activeTab, showShortcuts]);

    // Handle native copy event for maximum reliability (backup)
    useEffect(() => {
        const handleCopyNative = (_e: ClipboardEvent) => {
            const selection = window.getSelection();
            const selectedText = selection ? selection.toString() : "";

            // If we have selected text being copied via browser/OS native command (like context menu copy)
            if (selectedText.length > 0) {
                // We still let the browser handle the actual write to clipboard if triggered natively,
                // but we trigger our DB refresh logic.
                setCopyFeedback(true);
                setTimeout(() => setCopyFeedback(false), 1500);
            }
        };

        window.addEventListener("copy", handleCopyNative);
        return () => window.removeEventListener("copy", handleCopyNative);
    }, [selectedIndex, handleCopy]);



    useEffect(() => {
        const handleMouseUpGlobal = () => {
            // Record if we were dragging segments
            wasDraggingSegmentsRef.current = isDraggingSegmentsRef.current;

            // Segment dragging reset
            isDraggingSegmentsRef.current = false;
            segmentDragStartIdx.current = null;
            segmentDragActiveId.current = null;

            // Clear wasDraggingSegments after a short delay
            setTimeout(() => {
                wasDraggingSegmentsRef.current = false;
            }, 100);
        };
        window.addEventListener("mouseup", handleMouseUpGlobal);
        return () => window.removeEventListener("mouseup", handleMouseUpGlobal);
    }, []);

    // Global Context Menu (Right Click) for Text Selection
    useEffect(() => {
        const handleContextMenuGlobal = (e: MouseEvent) => {
            e.preventDefault(); // Prevent default Tauri context menu

            const selection = window.getSelection();
            const selectedText = selection ? selection.toString().trim() : "";

            if (selectedText.length > 0) {
                setContextMenu({
                    x: e.clientX,
                    y: e.clientY,
                    text: selectedText
                });
            } else {
                setContextMenu(null);
            }
        };

        const handleClickGlobal = () => {
            if (contextMenu) {
            }
            setContextMenu(null);
        };

        window.addEventListener("contextmenu", handleContextMenuGlobal);
        window.addEventListener("click", handleClickGlobal);

        return () => {
            window.removeEventListener("contextmenu", handleContextMenuGlobal);
            window.removeEventListener("click", handleClickGlobal);
        };
    }, []);

    // Infinite scroll: load more when sentinel becomes visible
    useEffect(() => {
        if (!sentinelRef.current) return;
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries[0].isIntersecting && hasMore) {
                    loadClips(false);
                }
            },
            { threshold: 0.1 }
        );
        observer.observe(sentinelRef.current);
        return () => observer.disconnect();
    }, [hasMore, loadClips]);

    // Reset selection when filters change
    useEffect(() => {
        setSelectedIndex(0);
    }, [activeTab, debouncedSearch]);

    const toggleFavorite = async (e: React.MouseEvent, id: number) => {
        e.stopPropagation();
        const btn = e.currentTarget as HTMLElement;
        btn.style.transform = 'scale(1.4)';
        setTimeout(() => { btn.style.transform = ''; }, 200);
        await invoke("toggle_favorite", { id });
        await loadClips();
    };

    const togglePin = async (e: React.MouseEvent, id: number) => {
        e.stopPropagation();
        const btn = e.currentTarget as HTMLElement;
        btn.style.transform = 'scale(1.4)';
        setTimeout(() => { btn.style.transform = ''; }, 200);
        await invoke("toggle_pin", { id });
        await loadClips();
    };

    const [undoDelete, setUndoDelete] = useState<{ id: number; timer: ReturnType<typeof setTimeout> } | null>(null);

    const deleteClip = async (id: number) => {
        // Optimistic remove from UI
        setClips(prev => prev.filter(c => c.id !== id));
        // Delayed actual delete with undo window
        const timer = setTimeout(async () => {
            await invoke("delete_clip", { id });
            setUndoDelete(null);
        }, 3000);
        setUndoDelete({ id, timer });
    };

    const handleUndoDelete = () => {
        if (undoDelete) {
            clearTimeout(undoDelete.timer);
            setUndoDelete(null);
            loadClips(); // Restore from DB
        }
    };

    const clearHistory = async () => {
        await invoke("clear_history");
        setIsClearConfirmOpen(false);
        loadClips();
    };

    const handlePinToScreen = async (e: React.MouseEvent, clip: Clip) => {
        e.stopPropagation();
        await invoke("open_float_window", { id: clip.id, image_path: clip.content });
    };

    const TIME_FILTER_MS: Record<string, number> = {
        "30m": 30 * 60 * 1000,
        "2h": 2 * 60 * 60 * 1000,
        "3h": 3 * 60 * 60 * 1000,
        "1d": 24 * 60 * 60 * 1000,
        "3d": 3 * 24 * 60 * 60 * 1000,
    };

    const filteredClips = useMemo(() => {
        const now = Date.now();
        const result: Clip[] = [];
        for (const clip of clips) {
            // 1. Tab Filter
            if (activeTab === "favorite") {
                if (!clip.is_favorite) continue;
            } else if (activeTab !== "all") {
                if (clip.type !== activeTab) continue;
            }

            // 2. Search Filter
            if (debouncedSearch) {
                let matches = false;
                if (debouncedSearch.startsWith("type:")) {
                    const typeQuery = debouncedSearch.split(":")[1].toLowerCase().trim();
                    if (clip.type.toLowerCase() === typeQuery) matches = true;
                } else if (debouncedSearch.startsWith("/") && debouncedSearch.endsWith("/") && debouncedSearch.length > 2) {
                    try {
                        const regex = new RegExp(debouncedSearch.slice(1, -1), "i");
                        if (regex.test(clip.content)) matches = true;
                    } catch {
                        const lowerSearch = debouncedSearch.toLowerCase();
                        if (clip.content.toLowerCase().includes(lowerSearch) || clip.type.toLowerCase().includes(lowerSearch)) matches = true;
                    }
                } else {
                    const lowerSearch = debouncedSearch.toLowerCase();
                    if (clip.content.toLowerCase().includes(lowerSearch) || clip.type.toLowerCase() === lowerSearch) matches = true;
                }
                if (!matches) continue;
            }

            // 3. Source App Filter
            if (sourceAppFilter) {
                if (clip.source_app !== sourceAppFilter) continue;
            }

            // 4. Time Filter
            if (timeFilter && TIME_FILTER_MS[timeFilter]) {
                const diffMs = now - new Date(clip.created_at).getTime();
                if (diffMs > TIME_FILTER_MS[timeFilter]) continue;
            }

            result.push(clip);
        }
        return result;
    }, [clips, activeTab, debouncedSearch, timeFilter, sourceAppFilter]);

    // Keep ref in sync so keyboard handler always reads current list
    filteredClipsRef.current = filteredClips;

    // Stable GroupKey set, locale-independent. Display via t('time.' + key).
    const availableGroups = useMemo(() => {
        return Array.from(new Set(filteredClips.map(clip => getGroupKey(clip.created_at))));
    }, [filteredClips]);

    const renderContent = (clip: Clip) => {
        if (clip.type === "image") {
            return (
                <div className="relative group mt-1">
                    <img
                        src={convertFileSrc(clip.content)}
                        alt="Clipboard Image"
                        className="max-h-48 rounded-md border border-gray-700 object-contain bg-black/20 cursor-pointer hover:opacity-80 transition-opacity"
                        onClick={(e) => {
                            e.stopPropagation();
                            setPreviewImage(clip.content);
                        }}
                    />
                    <div className="absolute top-2 right-2 bg-[var(--panel-bg)]/80 border border-[var(--border-color)] p-1 px-2 rounded text-[10px] text-[var(--text-main)] backdrop-blur-sm">{t('preview.image_badge')}</div>
                    <div className="absolute bottom-2 right-2 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                setPreviewImage(clip.content);
                                setOcrLoading(true);
                                const t0 = performance.now();
                                invoke("perform_ocr", { id: clip.id, path: clip.content })
                                    .then((res) => {
                                        const r = res as OcrResult;
                                        console.log(`[OCR] ${(performance.now() - t0).toFixed(0)}ms · ${r.lines.length} lines · ${r.text.length} chars`);
                                        setOcrData(r);
                                    })
                                    .catch((err) => {
                                        console.error("AI 识别错误:", err);
                                        setOcrData(null);
                                        setPreviewImage(null);
                                    })
                                    .finally(() => setOcrLoading(false));
                            }}
                            className="bg-indigo-600/90 hover:bg-indigo-500 text-white p-1.5 rounded-md flex items-center gap-1 text-xs backdrop-blur-md shadow-lg"
                        >
                            <ScanSearch size={14} /> {t('action.ai_ocr')}
                        </button>
                    </div>
                </div>
            );
        }
        if (clip.type === "link") {
            return (
                <div className="flex items-center gap-2 text-indigo-500 break-all bg-indigo-500/10 p-2 rounded-lg border border-indigo-500/20">
                    <LinkIcon size={16} className="shrink-0" />
                    <a href={clip.content} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="hover:underline">
                        <HighlightText text={clip.content} highlight={search} />
                    </a>
                </div>
            );
        }
        if (clip.type === "code") {
            const detectedLang = detectLanguage(clip.content);
            return (
                <div className="w-full mt-2 group relative">
                    <div className="rounded-xl overflow-hidden border border-[var(--border-color)] shadow-2xl bg-[var(--input-bg)] transition-all group-hover:border-indigo-500/30">
                        {/* Code Header */}
                        <div className="flex items-center justify-between px-4 py-2 bg-[var(--header-bg)]/40 border-b border-[var(--border-color)] backdrop-blur-md">
                            <div className="flex items-center gap-2">
                                <div className="w-2 h-2 rounded-full bg-indigo-500 shadow-[0_0_8px_rgba(99,102,241,0.6)]" />
                                <span className="text-[10px] font-bold text-[var(--text-dim)] uppercase tracking-widest">{detectedLang}</span>
                            </div>
                            <button
                                onClick={(e) => { e.stopPropagation(); handleCopy(clip); }}
                                className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[var(--text-dim)] hover:text-[var(--text-main)] hover:bg-[var(--panel-hover)] transition-all active:scale-95"
                            >
                                <Copy size={12} />
                                <span className="text-[10px] font-bold">{t('action.copy_all')}</span>
                            </button>
                        </div>

                        <LazyCodeBlock
                            language={detectedLang}
                            theme={theme}
                            code={clip.content.length > 2000 ? clip.content.slice(0, 2000) + "\n... (truncated for preview)" : clip.content}
                        />
                    </div>

                </div>
            );
        }
        if (clip.type === "file") {
            const isImageFile = /\.(png|jpg|jpeg|gif|bmp|webp|svg|ico)$/i.test(clip.content);

            if (isImageFile) {
                return (
                    <div className="relative group mt-1">
                        <img
                            src={convertFileSrc(clip.content)}
                            alt="Clipboard Image File"
                            className="max-h-48 rounded-md border border-gray-700 object-contain bg-black/20 cursor-pointer hover:opacity-80 transition-opacity"
                            onClick={(e) => {
                                e.stopPropagation();
                                setPreviewImage(clip.content);
                            }}
                        />
                        <div className="absolute top-2 right-2 bg-[var(--panel-bg)]/80 border border-[var(--border-color)] p-1 px-2 rounded text-[10px] text-[var(--text-main)] backdrop-blur-sm">{t('preview.file_badge')}</div>
                    </div>
                );
            }

            return (
                <div className="flex items-center gap-3 bg-[var(--input-bg)] p-2 rounded-lg border border-[var(--border-color)]">
                    <FileText size={24} className="text-[var(--text-dim)]" />
                    <span className="text-[var(--text-main)] break-all text-sm font-mono">
                        <HighlightText text={clip.content} highlight={search} />
                    </span>
                </div>
            )
        }

        // Plain text processing
        const MAX_LENGTH = 300;
        const isLongText = clip.content.length > MAX_LENGTH;
        const isExpanded = expandedClips.includes(clip.id);
        const isSegmenting = segmentingClips.includes(clip.id);

        return (
            <div className="flex flex-col gap-2 items-start w-full"
                onMouseLeave={() => {
                    // Stop segment dragging when leaving the container to be safe, 
                    // though global mouseup handles it too.
                }}
            >
                {isSegmenting ? (
                    <div className="flex flex-col gap-3 p-3 bg-[var(--input-bg)]/30 rounded-xl border border-[var(--border-color)] w-full animate-in fade-in duration-300">
                        <div className="flex flex-wrap gap-1.5 min-h-[40px]">
                            {(() => {
                                const segments = Array.from(new (Intl as any).Segmenter('zh', { granularity: 'word' }).segment(clip.content))
                                    .map((s: any) => s.segment)
                                    .filter(s => s.trim().length > 0);

                                const clipSelectedIndices = selectedSegments[clip.id] || [];

                                return segments.map((word, i) => {
                                    const isChipSelected = clipSelectedIndices.includes(i);
                                    return (
                                        <button
                                            key={i}
                                            onMouseDown={(e) => {
                                                e.stopPropagation();
                                                if (e.button === 0) { // Left click
                                                    isDraggingSegmentsRef.current = true;
                                                    segmentDragStartIdx.current = i;
                                                    segmentDragActiveId.current = clip.id;

                                                    // Toggle selection if Ctrl/Meta is held, otherwise start new selection
                                                    if (e.ctrlKey || e.metaKey || isChipSelected) {
                                                        setSelectedSegments(prev => {
                                                            const current = prev[clip.id] || [];
                                                            return {
                                                                ...prev,
                                                                [clip.id]: current.includes(i) ? current.filter(x => x !== i) : [...current, i]
                                                            };
                                                        });
                                                    } else {
                                                        setSelectedSegments(prev => ({
                                                            ...prev,
                                                            [clip.id]: [i]
                                                        }));
                                                    }
                                                }
                                            }}
                                            onMouseEnter={() => {
                                                if (isDraggingSegmentsRef.current && segmentDragActiveId.current === clip.id && segmentDragStartIdx.current !== null) {
                                                    const start = Math.min(segmentDragStartIdx.current, i);
                                                    const end = Math.max(segmentDragStartIdx.current, i);
                                                    const newRange = Array.from({ length: end - start + 1 }, (_, k) => start + k);

                                                    setSelectedSegments(prev => {
                                                        const current = prev[clip.id] || [];
                                                        // Merge dragged range with existing selection for true multi-select
                                                        const merged = new Set([...current, ...newRange]);
                                                        return {
                                                            ...prev,
                                                            [clip.id]: Array.from(merged)
                                                        };
                                                    });
                                                }
                                            }}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                // Removed immediate single-copy on click so users can multi-select freely.
                                                // If they want to copy quickly, they can double click or use the "Copy Selected" button.
                                            }}
                                            onDoubleClick={(e) => {
                                                e.stopPropagation();
                                                // Quick copy on double click
                                                handleCopy({ content: word, type: "text" } as Clip);
                                            }}
                                            className={`px-3 py-1.5 rounded-lg border text-xs font-medium transition-all duration-200 active:scale-95 select-none ${isChipSelected
                                                ? "bg-indigo-600 border-indigo-400 text-white shadow-[0_4px_12px_rgba(79,70,229,0.3)] z-10"
                                                : "bg-[var(--panel-bg)] border-[var(--border-color)] text-[var(--text-main)] hover:border-indigo-500/50 hover:text-indigo-500 hover:bg-[var(--panel-hover)]"
                                                }`}
                                        >
                                            {word}
                                        </button>
                                    );
                                });
                            })()}
                        </div>

                        {(selectedSegments[clip.id]?.length || 0) > 0 && (
                            <div className="glass flex items-center justify-between pt-2 border-t border-[var(--border-color)] animate-in slide-in-from-bottom-2 duration-300 rounded-lg px-3 py-2 mt-1">
                                <span className="text-[10px] text-[var(--text-dim)]">{t('text.segments_selected', { n: selectedSegments[clip.id].length })}</span>
                                <div className="flex gap-2">
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            setSelectedSegments(prev => {
                                                const next = { ...prev };
                                                delete next[clip.id];
                                                return next;
                                            });
                                        }}
                                        className="text-[10px] text-[var(--text-dim)] hover:text-[var(--text-main)] px-2 py-1"
                                    >
                                        {t('action.cancel')}
                                    </button>
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            const segments = Array.from(new (Intl as any).Segmenter('zh', { granularity: 'word' }).segment(clip.content))
                                                .map((s: any) => s.segment)
                                                .filter(s => s.trim().length > 0);
                                            const selectedWords = (selectedSegments[clip.id] || [])
                                                .sort((a, b) => a - b)
                                                .map(idx => segments[idx])
                                                .join("");
                                            handleCopy({ content: selectedWords, type: "text" } as Clip);
                                            // Reset selection after copy
                                            setSelectedSegments(prev => {
                                                const next = { ...prev };
                                                delete next[clip.id];
                                                return next;
                                            });
                                        }}
                                        className="px-3 py-1 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-[10px] font-bold shadow-lg shadow-blue-500/20 transition-all flex items-center gap-1"
                                    >
                                        <Copy size={10} />
                                        {t('action.copy_selected')}
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                ) : clip.content_html && clip.content_html.length < 50000 ? (
                    <div
                        className={`rich-text-preview text-[var(--text-main)] break-words text-sm leading-relaxed w-full transition-all duration-300 ${!isExpanded && isLongText ? 'max-h-[84px] overflow-hidden' : ''}`}
                        dangerouslySetInnerHTML={{ __html: sanitizeHtml(clip.content_html) }}
                    />
                ) : (
                    <div className={`text-[var(--text-main)] break-words whitespace-pre-wrap font-sans text-sm leading-relaxed w-full transition-all duration-300 ${!isExpanded && isLongText ? 'max-h-[84px] overflow-hidden' : ''}`}>
                        <HighlightText text={isExpanded || !isLongText ? clip.content : clip.content.slice(0, MAX_LENGTH) + "..."} highlight={search} />
                    </div>
                )}
                
                <div className="flex gap-2 mt-1">
                    {isLongText && !isSegmenting && (
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                setExpandedClips(prev =>
                                    isExpanded ? prev.filter(id => id !== clip.id) : [...prev, clip.id]
                                );
                            }}
                            className="text-[10px] font-bold text-indigo-400/80 hover:text-indigo-300 bg-indigo-500/10 hover:bg-indigo-500/20 px-2 py-0.5 rounded transition-colors"
                        >
                            {isExpanded ? t('text.collapse') : t('text.expand')}
                        </button>
                    )}
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            setSegmentingClips(prev =>
                                isSegmenting ? prev.filter(id => id !== clip.id) : [...prev, clip.id]
                            );
                        }}
                        className={`text-[10px] font-bold px-2 py-0.5 rounded transition-colors flex items-center gap-1 ${isSegmenting
                            ? "text-white bg-indigo-600 hover:bg-indigo-500"
                            : "text-cyan-400/80 hover:text-cyan-300 bg-cyan-500/10 hover:bg-cyan-500/20"
                            }`}
                    >
                        {isSegmenting ? t('text.exit_segment') : t('text.segment')}
                    </button>
                </div>
            </div>
        );
    };

    return (
        <div className={`h-screen ${theme} bg-[var(--bg-color)] text-[var(--text-main)] selection:bg-indigo-500/30 overflow-hidden transition-colors duration-300 flex flex-col rounded-xl border border-white/10 shadow-2xl`}>
            {/* Custom Title Bar */}
            <div data-tauri-drag-region className="h-8 flex items-center justify-between bg-[var(--header-bg)] border-b border-[var(--border-color)] select-none shrink-0 transition-colors duration-500">
                <div className="flex items-center gap-2 px-3 pointer-events-none">
                    <div 
                        className="w-6 h-6 rounded-full border-2 flex items-center justify-center animate-docs-breathe animate-color-cycle shadow-[0_0_8px_rgba(88,166,255,0.2)] ml-1"
                        style={{ borderColor: 'var(--accent-color)' }}
                    >
                        <div 
                            className="w-2 h-2 rounded-full animate-docs-breathe-delayed"
                            style={{ backgroundColor: 'var(--accent-color)' }}
                        />
                    </div>
                    <span className="text-[14px] font-bold tracking-widest text-[#d1d5db] uppercase font-mono ml-1.5 pt-0.5">Super Clip</span>
                </div>
                
                <div className="flex items-center h-full">
                    <button 
                        onClick={toggleTheme}
                        className="h-full px-3 text-gray-500 hover:text-indigo-400 hover:bg-[var(--panel-hover)] transition-all outline-none border-none cursor-pointer bg-transparent"
                    >
                        {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
                    </button>
                    <button 
                        onClick={() => appWindow.minimize()}
                        className="h-full px-3 text-gray-500 hover:bg-[var(--panel-hover)] transition-all outline-none border-none cursor-pointer bg-transparent"
                    >
                        <Minus size={14} />
                    </button>
                    <button 
                        onClick={() => appWindow.toggleMaximize()}
                        className="h-full px-3 text-gray-500 hover:bg-[var(--panel-hover)] transition-all outline-none border-none cursor-pointer bg-transparent"
                    >
                        <Square size={12} />
                    </button>
                    <button 
                        onClick={() => invoke('hide_window')}
                        className="h-full px-3 text-gray-500 hover:bg-red-500/80 hover:text-white transition-all outline-none border-none cursor-pointer bg-transparent"
                    >
                        <X size={14} />
                    </button>
                </div>
            </div>

            <div className="flex-1 flex flex-col overflow-hidden relative">
            {/* Header */}
            <div className="p-4 glass sticky top-0 z-20 space-y-3 shadow-xl">
                {/* Search */}
                <div className="relative group">
                    <input
                        type="text"
                        placeholder={t('search.placeholder')}
                        aria-label={t('search.placeholder')}
                        className="w-full bg-[var(--input-bg)] border border-[var(--border-color)] rounded-lg pl-10 pr-12 py-2 text-sm focus:outline-none focus:border-indigo-500/50 transition-all placeholder:text-[var(--text-dim)] focus:bg-[var(--panel-hover)]"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                    />
                    <div className="absolute right-3 top-2 flex items-center gap-2">
                        <Tooltip text={isMultiSelect ? t('multi.cancel') : t('multi.toggle')} position="bottom" offset={28}>
                            <button
                                onClick={() => {
                                    setIsMultiSelect(!isMultiSelect);
                                    if (!isMultiSelect) {
                                        setSelectedIds([]);
                                        setLastSelectedId(null);
                                    }
                                }}
                                className={`transition-colors p-1.5 rounded-lg ${isMultiSelect ? "text-blue-400 bg-blue-400/10" : "text-gray-500 hover:text-blue-400 hover:bg-white/5"}`}
                            >
                                <CheckSquare size={18} />
                            </button>
                        </Tooltip>

                        {isMultiSelect && (
                            <Tooltip text={t('multi.select_all')} position="bottom" offset={28}>
                                <button
                                    onClick={handleSelectAll}
                                    className="p-1.5 rounded-lg text-gray-500 hover:text-indigo-400 hover:bg-white/5 transition-colors"
                                >
                                    {selectedIds.length === filteredClips.length && filteredClips.length > 0 ? <CheckSquare size={18} className="text-indigo-400" /> : <Square size={18} />}
                                </button>
                            </Tooltip>
                        )}

                        <Tooltip text={t('dash.clear')} position="bottom" offset={28}>
                            <button
                                onClick={() => setIsClearConfirmOpen(true)}
                                className="p-1.5 rounded-lg text-gray-500 hover:text-red-400 hover:bg-white/5 transition-colors"
                            >
                                <Eraser size={18} />
                            </button>
                        </Tooltip>

                        <Tooltip text={t('dash.title')} position="bottom" offset={28}>
                            <button
                                onClick={() => setIsDashboard(!isDashboard)}
                                className={`transition-colors p-1.5 rounded-lg ${isDashboard ? "text-blue-400 bg-blue-400/10" : "text-gray-500 hover:text-blue-400 hover:bg-white/5"}`}
                            >
                                <LayoutDashboard size={18} />
                            </button>
                        </Tooltip>

                        <Tooltip text={t('dash.settings')} position="bottom" offset={28}>
                            <button
                                onClick={() => setIsSettingsOpen(true)}
                                className="p-1.5 rounded-lg text-gray-500 hover:text-indigo-400 hover:bg-white/5 transition-colors"
                            >
                                <SettingsIcon size={18} />
                            </button>
                        </Tooltip>
                    </div>
                </div>

                {/* Tabs */}
                <div className="flex gap-2 overflow-x-auto pb-1 no-scrollbar">
                    {TAB_DEFS.map((tab) => {
                        const Icon = tab.icon;
                        const isActive = activeTab === tab.id;
                        return (
                            <button
                                key={tab.id}
                                onClick={() => setActiveTab(tab.id)}
                                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all whitespace-nowrap ${isActive
                                    ? "bg-blue-600 text-white shadow-lg shadow-blue-500/20"
                                    : "bg-[var(--input-bg)] text-[var(--text-dim)] hover:bg-[var(--panel-hover)] hover:text-[var(--text-main)]"
                                    }`}
                            >
                                {Icon && <Icon size={12} className={isActive ? "text-white" : "text-gray-500"} />}
                                {t(tab.key)}
                            </button>
                        )
                    })}
                </div>

                {/* Minimal filter status — only shows when filtering, doesn't conflict with dashboard */}
                {(sourceAppFilter || (activeTab !== "all" && !isDashboard)) && (
                    <div className="flex items-center gap-1.5 pt-1">
                        {sourceAppFilter && (
                            <button onClick={() => setSourceAppFilter(null)}
                                className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 hover:bg-cyan-500/20 transition-all">
                                <div className="w-1.5 h-1.5 rounded-full bg-cyan-400" />
                                {sourceAppFilter}
                                <X size={8} className="opacity-60" />
                            </button>
                        )}
                        {activeTab !== "all" && !isDashboard && (
                            <button onClick={() => setActiveTab("all")}
                                className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-500/10 text-blue-400 border border-blue-500/20 hover:bg-blue-500/20 transition-all">
                                {t(`tab.${activeTab}`)}
                                <X size={8} className="opacity-60" />
                            </button>
                        )}
                    </div>
                )}
            </div>

            {/* Main Content Area */}
            <div className="flex-1 flex overflow-hidden">
                {/* List View (Main) */}
                <div className={`flex-1 flex flex-col min-w-0 transition-all duration-300 ${isDashboard ? "border-r border-white/5" : ""}`}>
                    <div role="listbox" aria-label="Clipboard history" className="flex-1 overflow-y-auto p-4 space-y-4 scroll-smooth custom-scrollbar">
                        {filteredClips.length === 0 ? (
                            <div className="flex flex-col items-center justify-center h-full text-[var(--text-dim)] space-y-4 px-8">
                                {clips.length === 0 ? (
                                    <>
                                        <div className="w-16 h-16 rounded-2xl bg-indigo-500/10 flex items-center justify-center icon-float">
                                            <Copy size={28} className="text-indigo-400/60" />
                                        </div>
                                        <div className="text-center space-y-2">
                                            <p className="text-sm font-bold text-[var(--text-main)]">{t('welcome.title')}</p>
                                            <p className="text-[11px] leading-relaxed">{t('welcome.body')}<br/>{t('welcome.shortcut_hint')} <kbd className="px-1.5 py-0.5 rounded bg-white/5 border border-white/10 font-mono text-[10px]">?</kbd></p>
                                        </div>
                                    </>
                                ) : debouncedSearch ? (
                                    <>
                                        <ScanSearch size={28} className="opacity-20" />
                                        <p className="text-xs">{t('search.no_match_for', { q: debouncedSearch })}</p>
                                    </>
                                ) : (
                                    <>
                                        <Copy size={28} className="opacity-20" />
                                        <p className="text-xs">{t('search.no_filter_results')}</p>
                                    </>
                                )}
                            </div>
                        ) : (
                            (() => {
                                let currentKey: GroupKey | "" = "";
                                return filteredClips.map((clip, index) => {
                                    const isSelected = selectedIds.includes(clip.id);
                                    const key = getGroupKey(clip.created_at);
                                    const isNewGroup = key !== currentKey;
                                    if (isNewGroup) currentKey = key;

                                    return (
                                        <React.Fragment key={clip.id}>
                                            {isNewGroup && (
                                                <div id={`group-${key}`} className="sticky top-2 z-10 w-full flex justify-center mb-4 mt-2 pointer-events-none">
                                                    <span className="bg-[var(--panel-bg)]/90 backdrop-blur-md border border-[var(--border-color)] text-[var(--text-main)] px-4 py-1 rounded-full text-[10px] font-bold tracking-widest shadow-sm pointer-events-auto">
                                                        {t(`time.${key}`)}
                                                    </span>
                                                </div>
                                            )}
                                            <div
                                                role="option"
                                                aria-selected={index === selectedIndex}
                                                onClick={(e) => {
                                            // Single click only toggles multi-select.
                                            // Copying via single click was too easy to misfire — use
                                            // double-click, Enter, or the right-side Copy button instead.
                                            if (isMultiSelect) {
                                                toggleSelect(clip.id, e.shiftKey);
                                            } else {
                                                setSelectedIndex(index);
                                            }
                                        }}
                                        onDoubleClick={() => {
                                            if (!isMultiSelect) {
                                                handleCopy(clip);
                                            }
                                        }}
                                        onMouseEnter={() => {
                                            setSelectedIndex(index);
                                        }}
                                        className={`group glass hover:bg-[var(--panel-hover)] hover:shadow-xl border transition-all duration-300 cursor-pointer relative ${index === selectedIndex
                                            ? "border-blue-500 ring-4 ring-blue-500/10 z-10 scale-[1.01] shadow-2xl"
                                            : isSelected ? "border-blue-500/50 bg-blue-500/5 shadow-inner" : "border-[var(--border-color)] hover:border-blue-500/30"
                                            } rounded-2xl p-4 clip-entry`}
                                        style={{ "--index": Math.min(index, 15) } as React.CSSProperties}
                                    >
                                        {/* Multi-select Checkbox */}
                                        {isMultiSelect && (
                                            <div 
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    toggleSelect(clip.id, e.shiftKey);
                                                }}
                                                className={`absolute -left-2 -top-2 z-30 w-6 h-6 rounded-full border-2 flex items-center justify-center transition-all shadow-lg ${
                                                    isSelected 
                                                    ? "bg-indigo-600 border-indigo-400 scale-110" 
                                                    : "bg-[var(--panel-bg)] border-[var(--border-color)] hover:border-indigo-500"
                                                }`}
                                            >
                                                <div className={`w-2.5 h-2.5 rounded-full transition-all ${isSelected ? "bg-white scale-100" : "bg-transparent scale-0"}`} />
                                            </div>
                                        )}
                                        {/* Actions (visible on hover) */}
                                        <div className={`absolute top-3 right-3 flex gap-1 bg-[var(--header-bg)] rounded-lg shadow-xl z-20 border border-[var(--border-color)] transition-all duration-200 ${index === selectedIndex ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
                                            <Tooltip text={t('action.copy')}>
                                                <button
                                                    onClick={(e) => { e.stopPropagation(); handleCopy(clip); }}
                                                    className="p-1.5 rounded-md text-gray-500 hover:text-indigo-400 hover:bg-indigo-400/10 transition-colors"
                                                >
                                                    <Copy size={14} />
                                                </button>
                                            </Tooltip>
                                            <Tooltip text={clip.is_pinned ? t('action.unpin') : t('action.pin')}>
                                                <button
                                                    onClick={(e) => togglePin(e, clip.id)}
                                                    className={`p-1.5 rounded-md transition-colors ${clip.is_pinned ? "text-indigo-400" : "text-gray-500 hover:text-indigo-400 hover:bg-indigo-400/10"}`}
                                                >
                                                    <Pin size={14} fill={clip.is_pinned ? "currentColor" : "none"} />
                                                </button>
                                            </Tooltip>
                                            <Tooltip text={clip.is_favorite ? t('action.unfavorite') : t('action.favorite')}>
                                                <button
                                                    onClick={(e) => toggleFavorite(e, clip.id)}
                                                    className={`p-1.5 rounded transition-colors ${clip.is_favorite ? "text-yellow-500" : "text-gray-500 hover:text-yellow-500 hover:bg-yellow-500/10"}`}
                                                >
                                                    <Star size={14} fill={clip.is_favorite ? "currentColor" : "none"} />
                                                </button>
                                            </Tooltip>
                                            {clip.type === "image" && (
                                                <Tooltip text={t('action.float')}>
                                                    <button
                                                        onClick={(e) => handlePinToScreen(e, clip)}
                                                        className="p-1.5 rounded text-gray-500 hover:text-green-400 hover:bg-green-400/10 transition-colors"
                                                    >
                                                        <Maximize2 size={14} />
                                                    </button>
                                                </Tooltip>
                                            )}
                                            <Tooltip text={t('action.delete')}>
                                                <button
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        deleteClip(clip.id);
                                                    }}
                                                    className="p-1.5 rounded text-gray-500 hover:text-red-400 hover:bg-red-400/10 transition-colors"
                                                >
                                                    <Trash2 size={14} />
                                                </button>
                                            </Tooltip>
                                        </div>

                                        {/* Content */}
                                        <div className={isMultiSelect ? "pl-5" : ""}>
                                            {renderContent(clip)}
                                        </div>

                                        {/* Meta */}
                                        <div className="mt-3 flex items-center justify-between text-[11px] font-medium">
                                            <div className="flex items-center gap-2">
                                                <span className={`px-2 py-0.5 rounded font-bold uppercase tracking-wider border ${clip.type === 'code' ? 'bg-green-900/20 text-green-500 border-green-500/20' :
                                                    clip.type === 'image' ? 'bg-purple-900/20 text-purple-500 border-purple-500/20' :
                                                        clip.type === 'link' ? 'bg-blue-900/20 text-blue-500 border-blue-500/20' :
                                                            'bg-[var(--input-bg)] text-[var(--text-dim)] border-[var(--border-color)]'
                                                    }`}>{clip.type}</span>
                                                {clip.content_html && (
                                                    <span
                                                        title={t('badge.rich_text_tip')}
                                                        className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider border bg-amber-900/20 text-amber-400 border-amber-500/20"
                                                    >
                                                        {t('badge.rich_text')}
                                                    </span>
                                                )}
                                                <span className="text-gray-400">{new Date(clip.created_at).toLocaleString()}</span>
                                                {clip.source_app && (
                                                    <button
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            setSourceAppFilter(sourceAppFilter === clip.source_app ? null : clip.source_app!);
                                                        }}
                                                        className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full border font-bold transition-all cursor-pointer group shadow-sm ${
                                                            sourceAppFilter === clip.source_app
                                                                ? "bg-indigo-600/20 border-indigo-500/50 text-indigo-400"
                                                                : "bg-[var(--input-bg)] border-[var(--border-color)] text-[var(--text-dim)] hover:text-indigo-400 hover:border-indigo-500/30"
                                                        }`}
                                                    >
                                                        <div className="w-1.5 h-1.5 rounded-full bg-indigo-500 shadow-[0_0_8px_rgba(99,102,241,0.9)] group-hover:animate-pulse" />
                                                        <span className="opacity-80 group-hover:opacity-100">{clip.source_app}</span>
                                                    </button>
                                                )}
                                            </div>
                                        </div>

                                        {/* Entity Quick Actions */}
                                        {index === selectedIndex && entities.length > 0 && (
                                            <div className="mt-2 flex flex-wrap gap-1.5 animate-in fade-in duration-200">
                                                {entities.map((entity, ei) => (
                                                    <button
                                                        key={ei}
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            if (entity.entity_type === "url") {
                                                                window.open(entity.value, "_blank");
                                                            } else if (entity.entity_type === "email") {
                                                                window.open(`mailto:${entity.value}`, "_blank");
                                                            } else if (entity.entity_type === "json") {
                                                                try {
                                                                    const pretty = JSON.stringify(JSON.parse(entity.value), null, 2);
                                                                    handleCopy({ content: pretty, type: "text" } as Clip);
                                                                } catch {}
                                                            } else {
                                                                handleCopy({ content: entity.value, type: "text" } as Clip);
                                                            }
                                                        }}
                                                        className="flex items-center gap-1.5 px-2 py-1 rounded-lg border text-[10px] font-medium transition-all hover:scale-105 active:scale-95"
                                                        style={{
                                                            borderColor: entity.entity_type === "url" ? "rgba(59,130,246,0.3)" :
                                                                entity.entity_type === "email" ? "rgba(168,85,247,0.3)" :
                                                                entity.entity_type === "color" ? entity.value :
                                                                entity.entity_type === "json" ? "rgba(34,197,94,0.3)" :
                                                                "rgba(156,163,175,0.3)",
                                                            color: entity.entity_type === "url" ? "#60a5fa" :
                                                                entity.entity_type === "email" ? "#c084fc" :
                                                                entity.entity_type === "json" ? "#4ade80" :
                                                                "var(--text-dim)",
                                                            background: entity.entity_type === "url" ? "rgba(59,130,246,0.08)" :
                                                                entity.entity_type === "email" ? "rgba(168,85,247,0.08)" :
                                                                entity.entity_type === "json" ? "rgba(34,197,94,0.08)" :
                                                                "var(--input-bg)",
                                                        }}
                                                    >
                                                        {entity.entity_type === "color" && (
                                                            <span className="w-3 h-3 rounded-sm border border-white/20" style={{ backgroundColor: entity.value }} />
                                                        )}
                                                        <span>{entity.entity_type === "url" ? "Open" : entity.entity_type === "email" ? "Mail" : entity.entity_type === "json" ? "Format" : entity.entity_type === "ip" ? "IP" : entity.entity_type === "phone" ? "Phone" : entity.entity_type}</span>
                                                        <span className="opacity-60 max-w-[120px] truncate">{entity.display}</span>
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                    </React.Fragment>
                                );
                            })
                            })()
                        )}
                        {/* Infinite scroll sentinel */}
                        {hasMore && <div ref={sentinelRef} className="h-8" />}
                    </div>
                </div>

                {/* Floating Time Navigation Bar */}
                {availableGroups.length > 1 && (
                    <div className={`absolute ${isDashboard ? "right-[320px]" : "right-6"} top-1/2 -translate-y-1/2 z-30 bg-[var(--panel-bg)]/80 backdrop-blur-xl border border-[var(--border-color)] rounded-full p-2 shadow-2xl flex flex-col items-center gap-2 slide-in-from-right animate-in transition-all duration-300`}>
                        <button 
                            onClick={() => document.querySelector('.custom-scrollbar')?.scrollTo({ top: 0, behavior: 'smooth' })} 
                            className="p-1.5 text-gray-500 hover:text-[var(--text-main)] hover:bg-white/10 rounded-full transition-colors group"
                            title={t('nav.scroll_top')}
                        >
                            <ChevronUp size={16} className="group-hover:-translate-y-0.5 transition-transform"/>
                        </button>
                        <div className="w-px h-3 bg-white/10" />
                        
                        {availableGroups.map((groupKey) => (
                            <button
                                key={groupKey}
                                onClick={() => document.getElementById(`group-${groupKey}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                                title={t(`time.${groupKey}`)}
                                className="w-8 h-8 flex items-center justify-center rounded-full text-[11px] font-bold text-[var(--text-dim)] hover:text-[var(--text-main)] hover:bg-indigo-500/20 transition-all shadow-sm border border-transparent hover:border-indigo-500/30"
                            >
                                {NAV_SHORT_LABELS[groupKey]}
                            </button>
                        ))}

                        <div className="w-px h-3 bg-white/10" />
                        <button 
                            onClick={() => {
                                const container = document.querySelector('.custom-scrollbar');
                                container?.scrollTo({ top: container?.scrollHeight, behavior: 'smooth' });
                            }} 
                            className="p-1.5 text-gray-500 hover:text-[var(--text-main)] hover:bg-white/10 rounded-full transition-colors group"
                            title={t('nav.scroll_bottom')}
                        >
                            <ChevronDown size={16} className="group-hover:translate-y-0.5 transition-transform"/>
                        </button>
                    </div>
                )}

                {/* Dashboard Sidebar */}
                {isDashboard && (
                    <Dashboard
                        onClose={() => setIsDashboard(false)}
                        onOpenSettings={() => setIsSettingsOpen(true)}
                        onClearHistory={() => setIsClearConfirmOpen(true)}
                        onFilter={(val, type) => {
                            if (type === "type") {
                                setActiveTab(val);
                            } else if (type === "time") {
                                setTimeFilter(val);
                            } else if (type === "time_reset") {
                                setTimeFilter(null);
                                setActiveTab("all");
                                setSourceAppFilter(null);
                            } else if (type === "source_app") {
                                setSourceAppFilter(val);
                                setActiveTab("all");
                            } else {
                                setActiveTab("all");
                                setSearch(val);
                                setTimeFilter(null);
                            }
                        }}
                        activeTab={activeTab}
                        timeFilter={timeFilter}
                        clips={clips}
                    />
                )}
            </div>
        </div>

            {/* Custom Context Menu */}
            {contextMenu && (
                <div
                    className="fixed z-50 bg-[var(--panel-bg)] border border-[var(--border-color)] rounded-lg shadow-2xl overflow-hidden animate-in fade-in zoom-in duration-100"
                    style={{ left: Math.min(contextMenu?.x || 0, window.innerWidth - 150), top: Math.min(contextMenu?.y || 0, window.innerHeight - 50) }}
                >
                    <button
                        className="w-full text-left px-4 py-2 text-sm text-gray-200 hover:bg-indigo-500 hover:text-white transition-colors flex items-center gap-2"
                        onClick={(e) => {
                            e.stopPropagation();
                            // Use handleCopy instead of direct invoke so it gets the same feedback/logic
                            if (contextMenu) {
                                handleCopy({ content: contextMenu.text, type: "text" } as Clip);
                            }
                            setContextMenu(null);
                        }}
                    >
                        <Copy size={14} /> {t('ctx.copy_selection')}
                    </button>
                </div>
            )}

            {/* Multi-select Action Bar */}
            {
                isMultiSelect && selectedIds.length > 0 && (
                    <div className="fixed bottom-12 left-1/2 -translate-x-1/2 z-40 animate-in slide-in-from-bottom-4 duration-300">
                        <div className="bg-[var(--panel-bg)]/95 backdrop-blur-xl border border-[var(--border-color)] rounded-2xl p-2 px-4 shadow-2xl flex items-center gap-4">
                            <span className="text-[10px] font-bold text-[var(--text-dim)] uppercase tracking-widest">{t('multi.selected', { n: selectedIds.length })}</span>
                            <div className="flex items-center gap-1.5 ml-2">
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        if (selectedIds.length === filteredClips.length) {
                                            setSelectedIds([]);
                                        } else {
                                            setSelectedIds(filteredClips.map(c => c.id));
                                        }
                                    }}
                                    className="px-2 py-1 text-[10px] bg-white/5 hover:bg-white/10 text-[var(--text-main)] rounded transition-all flex items-center gap-1 border border-white/5"
                                >
                                    {selectedIds.length === filteredClips.length ? t('multi.deselect_all') : t('multi.select_all')}
                                </button>
                            </div>
                            <div className="w-px h-4 bg-[var(--border-color)]" />
                            <button
                                onClick={handleBulkCopy}
                                className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-bold transition-all hover:scale-105 active:scale-95 shadow-lg shadow-indigo-500/20"
                            >
                                <Copy size={13} /> {t('multi.merge_copy')}
                            </button>
                            <button
                                onClick={handleBulkDelete}
                                className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600/10 hover:bg-red-600/20 text-red-400 rounded-lg text-xs font-bold transition-all border border-red-500/20"
                            >
                                <Trash2 size={13} /> {t('multi.bulk_delete')}
                            </button>
                            <Tooltip text={t('multi.deselect')}>
                                <button
                                    onClick={() => setSelectedIds([])}
                                    className="p-1.5 hover:bg-white/5 text-gray-500 rounded-lg transition-colors"
                                >
                                    <X size={14} />
                                </button>
                            </Tooltip>
                        </div>
                    </div>
                )
            }

            {/* Footer / Status */}
            <div className="p-2 bg-[var(--header-bg)] border-t border-[var(--border-color)] text-[10px] text-[var(--text-dim)] flex justify-between px-4 select-none relative">
                <span>{t('footer.items', { filtered: String(filteredClips.length), total: String(clips.length) })}</span>
                <div className="flex gap-3">
                    <span>{t('footer.nav')}</span>
                    <span>{t('footer.click_copy')}</span>
                    <span>{t('footer.enter_paste')}</span>
                    <button onClick={() => setShowShortcuts(true)} className="text-indigo-400/60 hover:text-indigo-400 transition-colors">{t('footer.shortcuts')}</button>
                </div>
            </div>

            {/* Image Preview Modal — backed by the shared ImageOcrViewer */}
            {
                previewImage && (
                    <div
                        className="fixed inset-0 z-50 bg-black/95 backdrop-blur-md selection:bg-indigo-500/40"
                        onClick={() => { setPreviewImage(null); setOcrData(null); }}
                    >
                        <div className="absolute inset-0" onClick={(e) => e.stopPropagation()}>
                            <ImageOcrViewer
                                imageSrc={convertFileSrc(previewImage)}
                                ocrData={ocrData}
                                isOcrLoading={ocrLoading}
                                onRequestOcr={() => {
                                    const clip = clips.find(c => c.content === previewImage);
                                    if (!clip) return;
                                    setOcrLoading(true);
                                    const t0 = performance.now();
                                    invoke<OcrResult>("perform_ocr", { id: clip.id, path: clip.content })
                                        .then((r) => { console.log(`[OCR] ${(performance.now()-t0).toFixed(0)}ms · ${r.lines.length} lines · ${r.text.length} chars`); setOcrData(r); })
                                        .catch((err) => { console.error("AI 识别错误:", err); setOcrData(null); })
                                        .finally(() => setOcrLoading(false));
                                }}
                                onCopy={(text: string) => handleCopy({ content: text, type: "text" } as Clip)}
                                onClose={() => { setPreviewImage(null); setOcrData(null); }}
                            />
                        </div>
                    </div>
                )
            }
            {/* Settings Modal */}
            <Settings isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />

            {/* Bulk Delete Confirmation Modal */}
            {
                isBulkDeleteConfirmOpen && (
                    <div role="dialog" aria-modal="true" className="fixed inset-0 z-[110] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4 animate-in fade-in duration-200">
                        <div className="bg-[var(--panel-bg)] w-full max-w-sm rounded-2xl border border-[var(--border-color)] shadow-2xl p-6 space-y-4 animate-in zoom-in-95 duration-200">
                            <div className="flex items-center gap-3 text-red-500">
                                <AlertCircle size={24} />
                                <h3 className="font-semibold text-[var(--text-main)]">{t('modal.bulk_delete_title')}</h3>
                            </div>
                            <p className="text-sm text-[var(--text-dim)] leading-relaxed">
                                {t('modal.bulk_delete_body', { n: String(selectedIds.length) })}
                            </p>
                            <div className="flex gap-3 pt-2">
                                <button
                                    onClick={() => setIsBulkDeleteConfirmOpen(false)}
                                    className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium text-[var(--text-dim)] hover:text-[var(--text-main)] hover:bg-[var(--panel-hover)] transition-all"
                                >
                                    {t('action.cancel')}
                                </button>
                                <button
                                    onClick={performBulkDelete}
                                    className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium bg-red-600 hover:bg-red-500 text-white transition-all shadow-lg shadow-red-500/20"
                                >
                                    {t('action.confirm_delete')}
                                </button>
                            </div>
                        </div>
                    </div>
                )
            }

            {/* Clear All Confirmation Modal */}
            {
                isClearConfirmOpen && (
                    <div role="dialog" aria-modal="true" className="fixed inset-0 z-[110] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4 animate-in fade-in duration-200">
                        <div className="bg-[var(--panel-bg)] w-full max-w-sm rounded-2xl border border-[var(--border-color)] shadow-2xl p-6 space-y-4 animate-in zoom-in-95 duration-200">
                            <div className="flex items-center gap-3 text-red-500">
                                <Eraser size={24} />
                                <h3 className="font-semibold text-[var(--text-main)]">{t('modal.clear_title')}</h3>
                            </div>
                            <p className="text-sm text-[var(--text-dim)] leading-relaxed">
                                {t('modal.clear_body')}
                            </p>
                            <div className="flex gap-3 pt-2">
                                <button
                                    onClick={() => setIsClearConfirmOpen(false)}
                                    className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium text-[var(--text-dim)] hover:text-[var(--text-main)] hover:bg-[var(--panel-hover)] transition-all"
                                >
                                    {t('action.cancel')}
                                </button>
                                <button
                                    onClick={clearHistory}
                                    className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium bg-red-600 hover:bg-red-500 text-white transition-all shadow-lg shadow-red-500/20"
                                >
                                    {t('action.confirm_clear')}
                                </button>
                            </div>
                        </div>
                    </div>
                )
            }

            {/* Copy Confirmation Modal */}
            {
                copyConfirmClip && (
                    <div role="dialog" aria-modal="true" className="fixed inset-0 z-[110] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4 animate-in fade-in duration-200">
                        <div className="bg-[var(--panel-bg)] w-full max-w-sm rounded-2xl border border-[var(--border-color)] shadow-2xl p-6 space-y-4 animate-in zoom-in-95 duration-200">
                            <div className="flex items-center gap-3 text-indigo-500">
                                <Copy size={24} />
                                <h3 className="font-semibold text-[var(--text-main)]">{t('modal.copy_title')}</h3>
                            </div>
                            <p className="text-sm text-[var(--text-dim)] leading-relaxed">
                                {t('modal.copy_body')}
                            </p>
                            <label className="flex items-center gap-2 mt-2 cursor-pointer text-sm text-[var(--text-dim)] hover:text-[var(--text-main)] transition-colors">
                                <input
                                    type="checkbox"
                                    className="rounded border-[var(--border-color)] bg-[var(--input-bg)] text-indigo-500 focus:ring-indigo-500 cursor-pointer"
                                    id="remember-copy"
                                />
                                {t('modal.copy_remember')}
                            </label>
                            <div className="flex gap-3 pt-2">
                                <button
                                    onClick={() => setCopyConfirmClip(null)}
                                    className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium text-[var(--text-dim)] hover:text-[var(--text-main)] hover:bg-[var(--panel-hover)] transition-all"
                                >
                                    {t('action.cancel')}
                                </button>
                                <button
                                    onClick={() => {
                                        const remember = (document.getElementById("remember-copy") as HTMLInputElement)?.checked;
                                        if (remember) {
                                            localStorage.setItem("alwaysCopyToClipboard", "true");
                                            invoke("save_setting", { key: "alwaysCopyToClipboard", value: "true" }).catch(console.error);
                                        }
                                        executeCopy(copyConfirmClip.clip, copyConfirmClip.shouldPaste);
                                        setCopyConfirmClip(null);
                                    }}
                                    className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium bg-indigo-600 hover:bg-indigo-500 text-white transition-all shadow-lg shadow-indigo-500/20"
                                >
                                    {t('action.confirm_extract')}
                                </button>
                            </div>
                        </div>
                    </div>
                )
            }
            {/* Minimalist Mode Overlay */}
            {isMinimalist && (
                <MinimalistView
                    search={miniSearch}
                    onSearchChange={(val) => { setMiniSearch(val); setMiniSelectedIndex(0); }}
                    results={[
                        ...fuzzyResults.filter(c => {
                            if (fileCategory === "everything") return false;
                            if (fileCategory === "all" || fileCategory === "history") return true;
                            if (fileCategory === "doc" || fileCategory === "text") {
                                return c.type === "text" || c.type === "code" || (c.type === "file" && /\.(pdf|doc|docx|xls|xlsx|ppt|pptx|txt|md|rtf|csv)$/i.test(c.content));
                            }
                            if (fileCategory === "image") return c.type === "image" || (c.type === "file" && /\.(png|jpg|jpeg|gif|bmp|webp|svg|ico)$/i.test(c.content));
                            if (fileCategory === "link") return c.type === "link";
                            if (fileCategory === "code") return c.type === "code";
                            return false;
                        }).map(c => ({ ...c, is_file: false })),
                        ...snippetResults.map((s: any) => ({
                            id: -(s.id + 100000),
                            content: s.content,
                            type: "text" as const,
                            is_favorite: false,
                            is_pinned: false,
                            created_at: s.created_at,
                            source_app: `Snippet: ${s.name}`,
                            is_file: false,
                            is_snippet: true,
                        })),
                        ...everythingFiles.map(f => ({
                            id: -Math.random(), // Virtual ID
                            content: f.path,
                            type: "file",
                            is_favorite: false,
                            is_pinned: false,
                            created_at: new Date().toISOString(),
                            source_app: "Everything",
                            is_file: true,
                            file_info: f
                        }))
                    ]}
                    selectedIndex={miniSelectedIndex}
                    onSelect={setMiniSelectedIndex}
                    onCopy={async (item: any, shouldPaste) => {
                        if (item.is_file) {
                            await invoke("open_path", { path: item.content });
                        } else {
                            handleCopy(item, shouldPaste);
                        }
                        setIsMinimalist(false);
                    }}
                    onExit={() => setIsMinimalist(false)}
                    fileCategory={fileCategory}
                    setFileCategory={setFileCategory}
                    theme={theme}
                    everythingStatus={everythingStatus}
                />
            )}

            {/* Keyboard Shortcuts Help */}
            {showShortcuts && (
                <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowShortcuts(false)}>
                    <div className="bg-[var(--panel-bg)] border border-[var(--border-color)] rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4 animate-scale-in" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center justify-between">
                            <h3 className="text-base font-black text-[var(--text-main)]">{t('shortcuts.title')}</h3>
                            <button onClick={() => setShowShortcuts(false)} className="text-[var(--text-dim)] hover:text-[var(--text-main)] p-1 rounded-lg hover:bg-white/5"><X size={16} /></button>
                        </div>
                        <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-[12px]">
                            {[
                                ["Click", t('shortcut.click')],
                                ["Double-click", t('shortcut.dblclick')],
                                ["Enter", t('shortcut.enter')],
                                ["↑ ↓", t('shortcut.arrows')],
                                ["Space", t('shortcut.space')],
                                ["Esc", t('shortcut.esc')],
                                ["Ctrl+C", t('shortcut.ctrl_c')],
                                ["Ctrl+D", t('shortcut.ctrl_d')],
                                ["Ctrl+Space", t('shortcut.ctrl_space')],
                                ["Ctrl+M", t('shortcut.ctrl_m')],
                                ["Double Ctrl", t('shortcut.double_ctrl')],
                                ["?", t('shortcut.question')],
                            ].map(([key, desc]) => (
                                <div key={key} className="flex items-center justify-between py-1.5 border-b border-white/5">
                                    <kbd className="px-2 py-0.5 rounded-md bg-white/5 border border-white/10 text-[var(--text-main)] font-mono text-[11px] font-bold">{key}</kbd>
                                    <span className="text-[var(--text-dim)] text-[11px]">{desc}</span>
                                </div>
                            ))}
                        </div>
                        <p className="text-[10px] text-[var(--text-dim)] text-center pt-2">按 <kbd className="px-1.5 py-0.5 rounded bg-white/5 border border-white/10 font-mono text-[10px]">?</kbd> 或 <kbd className="px-1.5 py-0.5 rounded bg-white/5 border border-white/10 font-mono text-[10px]">Esc</kbd> 关闭</p>
                    </div>
                </div>
            )}

            {/* Undo Delete Toast */}
            {undoDelete && (
                <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-[150] animate-slide-up">
                    <div className="bg-[var(--panel-bg)]/95 backdrop-blur-xl border border-[var(--border-color)] rounded-xl px-4 py-3 shadow-2xl flex items-center gap-4">
                        <span className="text-[12px] text-[var(--text-main)]">{t('toast.deleted')}</span>
                        <button onClick={handleUndoDelete} className="text-[12px] font-bold text-indigo-400 hover:text-indigo-300 transition-colors px-2 py-1 rounded-lg hover:bg-indigo-500/10">
                            {t('toast.undo')}
                        </button>
                        <div className="w-12 h-1 bg-white/10 rounded-full overflow-hidden">
                            <div className="h-full bg-indigo-500 rounded-full" style={{ animation: 'shrink 3s linear forwards' }} />
                        </div>
                    </div>
                </div>
            )}

            {/* First-launch onboarding */}
            {showOnboarding && <Onboarding onClose={() => setShowOnboarding(false)} />}

            {/* Global Copy Toast — opaque bg so the "已复制到剪贴板" label
             * stays crisp over any content behind. Uses --panel-bg-solid
             * (a theme-aware fully-opaque twin of --panel-bg). */}
            {copyFeedback && (
                <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[200] pointer-events-none animate-scale-in">
                    <div className="bg-[var(--panel-bg-solid)] border border-indigo-500/30 rounded-2xl px-6 py-4 shadow-2xl shadow-indigo-500/25 flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-indigo-500/20 flex items-center justify-center">
                            <svg className="w-5 h-5 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" className="animate-[dash_0.3s_ease-out_forwards]" style={{ strokeDasharray: 20, strokeDashoffset: 20, animation: 'dash 0.3s ease-out 0.1s forwards' }} />
                            </svg>
                        </div>
                        <span className="text-sm font-bold text-[var(--text-main)]">{t('toast.copied')}</span>
                    </div>
                </div>
            )}

        </div>
    );
};

export default App;
