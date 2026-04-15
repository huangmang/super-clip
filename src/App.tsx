import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import OCRLayer, { OcrResult } from "./components/OCRLayer";
import { invoke } from "@tauri-apps/api/tauri";
import { listen } from "@tauri-apps/api/event";
import { convertFileSrc } from "@tauri-apps/api/tauri";
import { t, initLocale } from "./i18n";
import { appWindow } from "@tauri-apps/api/window";
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
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { atomDark, prism } from 'react-syntax-highlighter/dist/esm/styles/prism';

const getGroupLabel = (dateStr: string): string => {
    const d = new Date(dateStr);
    const now = new Date();
    const isSameDay = d.getDate() === now.getDate() && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const isYesterday = d.getDate() === yesterday.getDate() && d.getMonth() === yesterday.getMonth() && d.getFullYear() === yesterday.getFullYear();
    
    const diffTime = now.getTime() - d.getTime();
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24)); 
    
    if (isSameDay) {
        if (diffTime < 60 * 60 * 1000) return "一小时内";
        if (diffTime < 3 * 60 * 60 * 1000) return "三小时内";
        const hour = d.getHours();
        if (hour < 12) return "今天上午";
        if (hour < 18) return "今天下午";
        return "今天晚上";
    }
    if (isYesterday) return "昨天";
    if (diffDays <= 7) return "近7天";
    return "更早";
};

const NAV_SHORT_LABELS: Record<string, string> = {
    "一小时内": "1h",
    "三小时内": "3h",
    "今天上午": "早",
    "今天下午": "午",
    "今天晚上": "晚",
    "昨天": "昨",
    "近7天": "7d",
    "更早": "前"
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
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);
    const [isClearConfirmOpen, setIsClearConfirmOpen] = useState(false);
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
    const [theme, setTheme] = useState<'dark' | 'light'>('dark');
    const [entities, setEntities] = useState<{ entity_type: string; value: string; display: string }[]>([]);
    const [showShortcuts, setShowShortcuts] = useState(false);

    // Load theme Preference
    useEffect(() => {
        const initTheme = async () => {
            const saved = localStorage.getItem("theme");
            const dbTheme = await invoke("get_setting", { key: "theme" }).catch(() => null);
            const finalTheme = (dbTheme || saved || 'dark') as 'dark' | 'light';
            
            setTheme(finalTheme);
            if (finalTheme === 'light') {
                document.documentElement.classList.add("light");
            } else {
                document.documentElement.classList.remove("light");
            }
        };
        initTheme();
    }, []);

    const toggleTheme = () => {
        const newTheme = theme === 'dark' ? 'light' : 'dark';
        setTheme(newTheme);
        if (newTheme === 'light') {
            document.documentElement.classList.add("light");
        } else {
            document.documentElement.classList.remove("light");
        }
        localStorage.setItem("theme", newTheme);
        invoke("save_setting", { key: "theme", value: newTheme }).catch(console.error);
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
                    .then(setEverythingFiles)
                    .catch(() => setEverythingFiles([]));
            } else {
                setEverythingFiles([]);
            }
        }, 150);

        return () => clearTimeout(timer);
    }, [miniSearch, isMinimalist, fileCategory]);

    const [contextMenu, setContextMenu] = useState<{ x: number, y: number, text: string } | null>(null);

    const previewImgRef = useRef<HTMLImageElement>(null);
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
        console.log("[DEBUG] executeCopy called for item:", clip.id, "Type:", clip.type, "shouldPaste:", shouldPaste);
        try {
            await invoke("copy_to_clipboard", { content: clip.content, kind: clip.type });
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

    const handleBulkDelete = async () => {
        if (window.confirm(`确定删除选中的 ${selectedIds.length} 条记录吗？`)) {
            await invoke("batch_delete_clips", { ids: selectedIds });
            setSelectedIds([]);
            setIsMultiSelect(false);
            loadClips();
        }
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
                // 1. Close image preview
                if (previewImage) { setPreviewImage(null); setOcrData(null); return; }
                // 2. Close settings modal
                if (isSettingsOpen) { setIsSettingsOpen(false); return; }
                // 3. Close delete/clear/copy confirm dialogs
                if (deleteConfirmId) { setDeleteConfirmId(null); return; }
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
                const selection = window.getSelection();
                const selectedText = selection ? selection.toString() : "";

                console.log("[DEBUG] Ctrl+C keydown detected. SelectionLength:", selectedText.length, "SelectedIndex:", selectedIndex);

                if (selectedText.length > 0) {
                    console.log("[DEBUG] Priority Copy: Selected Text");
                    e.preventDefault();
                    handleCopy({ content: selectedText, type: "text" } as Clip);
                    return;
                }

                if (selectedIndex >= 0 && filteredClipsRef.current[selectedIndex]) {
                    console.log("[DEBUG] Priority Copy: Highlighted Item ID:", filteredClipsRef.current[selectedIndex].id);
                    e.preventDefault();
                    handleCopy(filteredClipsRef.current[selectedIndex]);
                    return;
                }

                console.log("[DEBUG] Ctrl+C: Nothing to copy.");
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
    }, [selectedIndex, previewImage, handleCopy, isSettingsOpen, deleteConfirmId, isClearConfirmOpen, copyConfirmClip, isMinimalist, isMultiSelect, sourceAppFilter, search, activeTab, showShortcuts]);

    // Handle native copy event for maximum reliability (backup)
    useEffect(() => {
        const handleCopyNative = (_e: ClipboardEvent) => {
            console.log("[DEBUG] Native 'copy' event fired (from menu or other source)");
            const selection = window.getSelection();
            const selectedText = selection ? selection.toString() : "";

            // If we have selected text being copied via browser/OS native command (like context menu copy)
            if (selectedText.length > 0) {
                // We still let the browser handle the actual write to clipboard if triggered natively,
                // but we trigger our DB refresh logic.
                console.log("[DEBUG] Native text selection copy detected.");
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
            console.log("[DEBUG] Context menu (right-click) fired");
            e.preventDefault(); // Prevent default Tauri context menu

            const selection = window.getSelection();
            const selectedText = selection ? selection.toString().trim() : "";
            console.log("[DEBUG] Right-click selected text:", selectedText);

            if (selectedText.length > 0) {
                console.log("[DEBUG] Opening custom text copy context menu");
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
                console.log("[DEBUG] Click triggered, closing context menu");
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
        setDeleteConfirmId(null);
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

    const availableGroups = useMemo(() => {
        return Array.from(new Set(filteredClips.map(clip => getGroupLabel(clip.created_at))));
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
                                console.log("[DEBUG] Target image:", clip.content);
                                invoke("perform_ocr", { id: clip.id, path: clip.content })
                                    .then((res) => setOcrData(res as OcrResult))
                                    .catch((err) => {
                                        console.error("AI 识别错误:", err);
                                        setOcrData(null);
                                        setPreviewImage(null);
                                    });
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

                        <SyntaxHighlighter
                            language={detectedLang}
                            style={theme === 'dark' ? atomDark : prism}
                            showLineNumbers={true}
                            lineNumberStyle={{ minWidth: '2.5em', paddingRight: '1em', color: 'var(--text-dim)', textAlign: 'right', fontSize: '11px', userSelect: 'none' }}
                            customStyle={{
                                margin: 0,
                                padding: '16px 12px',
                                fontSize: '12px',
                                lineHeight: '1.6',
                                background: 'transparent',
                                fontFamily: '"Fira Code", "Cascadia Code", "JetBrains Mono", monospace',
                            }}
                        >
                            {clip.content.length > 2000 ? clip.content.slice(0, 2000) + "\n... (truncated for preview)" : clip.content}
                        </SyntaxHighlighter>
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
                    <div className="flex-1 overflow-y-auto p-4 space-y-4 scroll-smooth custom-scrollbar">
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
                                        <p className="text-xs">未找到匹配 "<span className="text-indigo-400">{debouncedSearch}</span>" 的记录</p>
                                    </>
                                ) : (
                                    <>
                                        <Copy size={28} className="opacity-20" />
                                        <p className="text-xs">当前筛选条件下没有记录</p>
                                    </>
                                )}
                            </div>
                        ) : (
                            (() => {
                                let currentLabel = "";
                                return filteredClips.map((clip, index) => {
                                    const isSelected = selectedIds.includes(clip.id);
                                    const label = getGroupLabel(clip.created_at);
                                    const isNewGroup = label !== currentLabel;
                                    if (isNewGroup) currentLabel = label;

                                    return (
                                        <React.Fragment key={clip.id}>
                                            {isNewGroup && (
                                                <div id={`group-${label}`} className="sticky top-2 z-10 w-full flex justify-center mb-4 mt-2 pointer-events-none">
                                                    <span className="bg-[var(--panel-bg)]/90 backdrop-blur-md border border-[var(--border-color)] text-[var(--text-main)] px-4 py-1 rounded-full text-[10px] font-bold tracking-widest shadow-sm pointer-events-auto">
                                                        {label}
                                                    </span>
                                                </div>
                                            )}
                                            <div
                                                onClick={(e) => {
                                            if (isMultiSelect) {
                                                toggleSelect(clip.id, e.shiftKey);
                                            } else {
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
                        
                        {availableGroups.map((group) => (
                            <button
                                key={group}
                                onClick={() => document.getElementById(`group-${group}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                                title={group}
                                className="w-8 h-8 flex items-center justify-center rounded-full text-[11px] font-bold text-[var(--text-dim)] hover:text-[var(--text-main)] hover:bg-indigo-500/20 transition-all shadow-sm border border-transparent hover:border-indigo-500/30"
                            >
                                {NAV_SHORT_LABELS[group] || group.slice(0, 1)}
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

            {/* Image Preview Modal */}
            {
                previewImage && (
                    <div
                        className="fixed inset-0 z-50 flex items-center justify-center bg-black/95 backdrop-blur-md p-4 selection:bg-indigo-500/40"
                        onClick={() => { setPreviewImage(null); setOcrData(null); }}
                    >
                        <div className="relative max-w-full max-h-screen flex flex-col items-center gap-6 overflow-y-auto no-scrollbar py-10"
                             onClick={(e) => e.stopPropagation()}>
                            
                            {/* Image Container with Visual OCR Overlay */}
                            <div className="relative flex-shrink-0 select-none" style={{ userSelect: "none" }}>
                                <img
                                    ref={previewImgRef}
                                    src={previewImage ? convertFileSrc(previewImage) : ""}
                                    className="max-w-full max-h-[70vh] rounded-lg shadow-2xl object-contain pointer-events-none select-none"
                                />
                                <OCRLayer
                                    ocrData={ocrData || { lines: [], text: "" }}
                                    imgRef={previewImgRef}
                                />
                            </div>

                            {/* Simplified OCR Actions (Below Image) */}
                            {ocrData && (
                                <div className="w-full flex items-center justify-center mt-2 animate-in fade-in slide-in-from-top-4 duration-500">
                                    <div className="bg-[var(--panel-bg)]/80 border border-[var(--border-color)] rounded-full px-4 py-2 backdrop-blur-xl shadow-2xl flex items-center gap-4">
                                        <div className="flex items-center gap-2">
                                            <div className="w-2 h-2 rounded-full bg-indigo-500 animate-pulse" />
                                            <span className="text-xs font-bold text-[var(--text-main)]">{t('preview.ocr_done')}</span>
                                        </div>
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                handleCopy({ content: ocrData.text, type: "text" } as Clip);
                                            }}
                                            className="px-3 py-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-bold transition-all shadow-lg flex items-center gap-1.5"
                                        >
                                            <Copy size={12} /> {t('preview.copy_all_ocr')}
                                        </button>
                                    </div>
                                </div>
                            )}

                            <div className="mt-4 bg-black/50 text-[var(--text-dim)] text-[10px] px-4 py-1.5 rounded-full border border-white/5 backdrop-blur-md font-medium tracking-tight">
                                {t('preview.exit_hint')}
                            </div>
                        </div>

                        <button
                            onClick={() => { setPreviewImage(null); setOcrData(null); }}
                            className="absolute top-6 right-6 bg-white/5 hover:bg-white/10 text-white rounded-full p-2.5 border border-white/10 backdrop-blur-xl transition-all hover:rotate-90"
                        >
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                    </div>
                )
            }
            {/* Settings Modal */}
            <Settings isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />

            {/* Delete Confirmation Modal */}
            {
                deleteConfirmId && (
                    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4 animate-in fade-in duration-200">
                        <div className="bg-[var(--panel-bg)] w-full max-w-sm rounded-2xl border border-[var(--border-color)] shadow-2xl p-6 space-y-4 animate-in zoom-in-95 duration-200">
                            <div className="flex items-center gap-3 text-red-500">
                                <AlertCircle size={24} />
                                <h3 className="font-semibold text-[var(--text-main)]">{t('modal.delete_title')}</h3>
                            </div>
                            <p className="text-sm text-[var(--text-dim)] leading-relaxed">
                                {t('modal.delete_body')}
                            </p>
                            <div className="flex gap-3 pt-2">
                                <button
                                    onClick={() => setDeleteConfirmId(null)}
                                    className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium text-[var(--text-dim)] hover:text-[var(--text-main)] hover:bg-[var(--panel-hover)] transition-all"
                                >
                                    {t('action.cancel')}
                                </button>
                                <button
                                    onClick={() => deleteConfirmId && deleteClip(deleteConfirmId)}
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
                    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4 animate-in fade-in duration-200">
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
                    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4 animate-in fade-in duration-200">
                        <div className="bg-[var(--panel-bg)] w-full max-w-sm rounded-2xl border border-[var(--border-color)] shadow-2xl p-6 space-y-4 animate-in zoom-in-95 duration-200">
                            <div className="flex items-center gap-3 text-indigo-500">
                                <Copy size={24} />
                                <h3 className="font-semibold text-[var(--text-main)]">放入系统剪贴板</h3>
                            </div>
                            <p className="text-sm text-[var(--text-dim)] leading-relaxed">
                                是否将选中内容覆盖到系统剪贴板中？
                            </p>
                            <label className="flex items-center gap-2 mt-2 cursor-pointer text-sm text-[var(--text-dim)] hover:text-[var(--text-main)] transition-colors">
                                <input 
                                    type="checkbox" 
                                    className="rounded border-[var(--border-color)] bg-[var(--input-bg)] text-indigo-500 focus:ring-indigo-500 cursor-pointer"
                                    id="remember-copy"
                                />
                                记住选择，以后直接放入
                            </label>
                            <div className="flex gap-3 pt-2">
                                <button
                                    onClick={() => setCopyConfirmClip(null)}
                                    className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium text-[var(--text-dim)] hover:text-[var(--text-main)] hover:bg-[var(--panel-hover)] transition-all"
                                >
                                    取消
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
                                    确定提取
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

            {/* Global Copy Toast */}
            {copyFeedback && (
                <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[200] pointer-events-none animate-scale-in">
                    <div className="bg-[var(--panel-bg)]/95 backdrop-blur-xl border border-indigo-500/30 rounded-2xl px-6 py-4 shadow-2xl shadow-indigo-500/20 flex items-center gap-3">
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
