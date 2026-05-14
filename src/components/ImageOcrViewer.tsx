import { useEffect, useMemo, useRef, useState } from "react";
import type { ComponentType } from "react";
import { appWindow, LogicalSize } from "@tauri-apps/api/window";
import {
    X, Search, Maximize, Minimize, Copy, FileText, Table2, RotateCcw,
    Link as LinkIcon, Mail, Phone, Flame, Search as SearchGlassIcon,
    ChevronUp, ChevronDown, Check,
} from "lucide-react";
import OCRLayer, { OcrLine, OcrResult } from "./OCRLayer";
import {
    reconstructParagraphs, detectTable, tableToTsv,
    extractSmartLinks, SmartLink,
} from "../utils/ocrPostprocess";
import { t } from "../i18n";
import { GlassSurface, GLASS_TOKENS } from "./GlassSurface";
import { IconButton, type IconButtonAccent } from "./IconButton";

type ViewTransform = { s: number; tx: number; ty: number };
const IDENTITY_VIEW: ViewTransform = { s: 1, tx: 0, ty: 0 };
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 16;

export interface ImageOcrViewerProps {
    /** Pre-resolved image URL (e.g. `convertFileSrc(path)`). */
    imageSrc: string;
    ocrData: OcrResult | null;
    isOcrLoading?: boolean;
    /** Triggered when user clicks the "re-OCR" button. */
    onRequestOcr?: () => void;
    /** Copy text to the clipboard (implementation may differ between float window vs. main window). */
    onCopy: (text: string) => Promise<void> | void;
    /** Called when user clicks the close × button in top-right. If undefined, button is hidden. */
    onClose?: () => void;
    /** Enable Ctrl+wheel to resize the standalone Tauri window. */
    allowWindowResize?: boolean;
    /** Make the background a Tauri drag region (only in standalone window mode). */
    allowWindowDrag?: boolean;
}

/**
 * Single source of truth for the interactive OCR-on-image UI.
 * Rendered by both FloatImage (standalone window) and the App preview modal.
 */
export function ImageOcrViewer(props: ImageOcrViewerProps) {
    const { imageSrc, ocrData, isOcrLoading, onRequestOcr, onCopy, onClose, allowWindowResize, allowWindowDrag } = props;

    // ── State ──────────────────────────────────────────────────────────
    const [isStretched, setIsStretched] = useState(false);
    const [view, setView] = useState<ViewTransform>(IDENTITY_VIEW);
    const [multiSelected, setMultiSelected] = useState<OcrLine[]>([]);
    const [clearMultiToken, setClearMultiToken] = useState(0);
    const [hintDismissed, setHintDismissed] = useState(false);
    const [showHeatmap, setShowHeatmap] = useState(false);
    const [copySuccess, setCopySuccess] = useState(false);
    const [contextMenu, setContextMenu] = useState<{ x: number, y: number } | null>(null);
    // Ctrl+F search
    const [searchOpen, setSearchOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState("");
    const [searchCurrent, setSearchCurrent] = useState(0);

    const imgRef = useRef<HTMLImageElement>(null);
    const rootRef = useRef<HTMLDivElement>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const panStart = useRef<{ x: number, y: number, tx: number, ty: number } | null>(null);
    const multiSelectedRef = useRef<OcrLine[]>([]);

    useEffect(() => { multiSelectedRef.current = multiSelected; }, [multiSelected]);
    useEffect(() => { setHintDismissed(false); }, [ocrData]);
    // Reset search when OCR data changes
    useEffect(() => { setSearchQuery(""); setSearchOpen(false); setSearchCurrent(0); }, [ocrData]);

    const showToast = () => { setCopySuccess(true); setTimeout(() => setCopySuccess(false), 2000); };

    const doCopy = async (text: string) => {
        if (!text) return;
        await onCopy(text);
        showToast();
    };

    // ── Wheel: Ctrl→window resize (optional), plain→image content zoom ─
    useEffect(() => {
        const handleWheel = async (e: WheelEvent) => {
            if (e.ctrlKey) {
                if (!allowWindowResize) return; // skip in modal mode
                e.preventDefault();
                const factor = e.deltaY > 0 ? 0.9 : 1.1;
                const size = await appWindow.innerSize();
                const factorX = (await appWindow.scaleFactor()) || 1;
                await appWindow.setSize(new LogicalSize((size.width / factorX) * factor, (size.height / factorX) * factor));
                return;
            }
            const root = rootRef.current;
            if (!root) return;
            e.preventDefault();
            const rect = root.getBoundingClientRect();
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;
            setView(prev => {
                const rawFactor = e.deltaY > 0 ? 1 / 1.1 : 1.1;
                const newS = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, prev.s * rawFactor));
                const f = newS / prev.s;
                return { s: newS, tx: mx * (1 - f) + prev.tx * f, ty: my * (1 - f) + prev.ty * f };
            });
        };
        const el = rootRef.current;
        if (!el) return;
        el.addEventListener("wheel", handleWheel, { passive: false });
        return () => el.removeEventListener("wheel", handleWheel);
    }, [allowWindowResize]);

    const beginPan = (e: React.MouseEvent) => {
        panStart.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
        const onMove = (ev: MouseEvent) => {
            const s = panStart.current;
            if (!s) return;
            setView(v => ({ ...v, tx: s.tx + (ev.clientX - s.x), ty: s.ty + (ev.clientY - s.y) }));
        };
        const onUp = () => {
            panStart.current = null;
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
    };

    // ── Keyboard: Ctrl+C (multi-select priority), Ctrl+F (open search), Esc (layered dismiss) ──
    useEffect(() => {
        const handleKey = (e: KeyboardEvent) => {
            // Ctrl+F → open search (capture so parent doesn't see it)
            if ((e.ctrlKey || e.metaKey) && (e.code === "KeyF" || e.key.toLowerCase() === "f")) {
                if (!ocrData || ocrData.lines.length === 0) return;
                e.preventDefault();
                e.stopImmediatePropagation();
                setSearchOpen(true);
                setTimeout(() => searchInputRef.current?.focus(), 0);
                return;
            }
            // Ctrl+C → multi-select priority, else fall through
            if ((e.ctrlKey || e.metaKey) && (e.code === "KeyC" || e.key.toLowerCase() === "c")) {
                if (multiSelectedRef.current.length > 0) {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    const text = reconstructParagraphs(multiSelectedRef.current);
                    if (text) doCopy(text);
                    return;
                }
                // Let parent / browser handle native-selection copy
            }
            if (e.key === "Escape") {
                if (searchOpen) { e.preventDefault(); e.stopImmediatePropagation(); setSearchOpen(false); setSearchQuery(""); return; }
                if (multiSelectedRef.current.length > 0) {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    setMultiSelected([]);
                    setClearMultiToken(t => t + 1);
                    return;
                }
                if (onClose) { e.preventDefault(); e.stopImmediatePropagation(); onClose(); return; }
            }
        };
        // Capture phase so we run before App's window listener
        window.addEventListener("keydown", handleKey, true);
        return () => window.removeEventListener("keydown", handleKey, true);
    }, [ocrData, searchOpen, onClose]);

    // ── Derived: smart links + table detection ─────────────────────────
    const tableRows = useMemo(() => ocrData ? detectTable(ocrData.lines) : null, [ocrData]);
    const smartLinks: SmartLink[] = useMemo(() => ocrData ? extractSmartLinks(ocrData.text) : [], [ocrData]);

    // ── Derived: search highlights (char-level) ────────────────────────
    type Hit = { lineIdx: number; charStart: number; charEnd: number; isCurrent: boolean };
    const { hits, sortedLinesCount } = useMemo(() => {
        if (!searchOpen || !searchQuery || !ocrData) return { hits: [] as Hit[], sortedLinesCount: 0 };
        const sorted = [...ocrData.lines].filter(l => l.box_coords && l.box_coords.length >= 2).sort((a, b) => {
            const aY = Math.min(...a.box_coords!.map(p => p[1]));
            const bY = Math.min(...b.box_coords!.map(p => p[1]));
            if (Math.abs(aY - bY) > 10) return aY - bY;
            const aX = Math.min(...a.box_coords!.map(p => p[0]));
            const bX = Math.min(...b.box_coords!.map(p => p[0]));
            return aX - bX;
        });
        const needle = searchQuery.toLowerCase();
        const raw: Hit[] = [];
        for (let i = 0; i < sorted.length; i++) {
            const line = sorted[i];
            if (!line.chars || line.chars.length === 0) {
                // Coarse match on line text — single hit spanning nothing (skip for now)
                continue;
            }
            const lowerText = line.text.toLowerCase();
            let from = 0;
            while (true) {
                const idx = lowerText.indexOf(needle, from);
                if (idx === -1) break;
                // Map from text-codepoint index to chars[] index: PaddleOCR emits
                // one char per CTC peak, so text.length should match chars.length
                // for CJK; for mixed-ascii it still lines up 1:1 via the key table.
                const end = idx + needle.length;
                raw.push({ lineIdx: i, charStart: idx, charEnd: Math.min(end, line.chars.length), isCurrent: false });
                from = idx + Math.max(1, needle.length);
            }
        }
        const ci = raw.length === 0 ? 0 : Math.max(0, Math.min(searchCurrent, raw.length - 1));
        if (raw[ci]) raw[ci].isCurrent = true;
        return { hits: raw, sortedLinesCount: sorted.length };
    }, [searchOpen, searchQuery, ocrData, searchCurrent]);

    // Clamp currentIdx when hit count shrinks
    useEffect(() => {
        if (hits.length === 0) { if (searchCurrent !== 0) setSearchCurrent(0); return; }
        if (searchCurrent >= hits.length) setSearchCurrent(hits.length - 1);
    }, [hits.length]);
    void sortedLinesCount;

    const nextHit = () => { if (hits.length > 0) setSearchCurrent((c) => (c + 1) % hits.length); };
    const prevHit = () => { if (hits.length > 0) setSearchCurrent((c) => (c - 1 + hits.length) % hits.length); };

    const viewActive = view.s !== 1 || view.tx !== 0 || view.ty !== 0;

    const handleReset = async () => {
        setView(IDENTITY_VIEW);
        if (allowWindowResize && imgRef.current) {
            const { naturalWidth, naturalHeight } = imgRef.current;
            if (naturalWidth > 0) {
                const w = Math.min(naturalWidth, 800);
                const h = (w / naturalWidth) * naturalHeight;
                await appWindow.setSize(new LogicalSize(w, h));
            }
        }
    };

    // ── Top-right toolbar action config ──────────────────────────────────
    // Declarative list of buttons: icon + label + handler + state. Adding a
    // new control (translate line, send-to-LLM, export MD, …) means pushing
    // a new record here — no JSX-level edits to the toolbar container.
    type Action = {
        key: string;
        icon: ComponentType<{ size?: number; className?: string }>;
        label: string;
        onClick: () => void;
        accent?: IconButtonAccent;
        active?: boolean;
        disabled?: boolean;
        iconClassName?: string;
    };
    const hasCharData = !!ocrData?.lines?.some(l => l.chars && l.chars.length > 0);
    const hasOcrText = !!ocrData?.text;
    const hasOcrLines = !!ocrData && ocrData.lines.length > 0;
    const toolbarActions: Action[] = [
        {
            key: "stretch",
            icon: isStretched ? Minimize : Maximize,
            label: isStretched ? t("float.aspect_ratio") : t("float.stretch"),
            onClick: () => setIsStretched(s => !s),
            active: isStretched,
        },
        ...(onRequestOcr ? [{
            key: "ocr",
            icon: Search,
            label: t("float.ocr"),
            onClick: onRequestOcr,
            disabled: isOcrLoading,
            active: isOcrLoading,
            iconClassName: isOcrLoading ? "animate-spin" : "",
        } as Action] : []),
        {
            key: "heatmap",
            icon: Flame,
            label: t("float.heatmap"),
            onClick: () => setShowHeatmap(h => !h),
            disabled: !hasCharData,
            active: showHeatmap,
            accent: "rose",
        },
        {
            key: "search",
            icon: SearchGlassIcon,
            label: t("float.search_in_image"),
            onClick: () => {
                if (!hasOcrLines) return;
                setSearchOpen(true);
                setTimeout(() => searchInputRef.current?.focus(), 0);
            },
            disabled: !hasOcrLines,
        },
        {
            key: "copy_all",
            icon: FileText,
            label: t("float.copy_all"),
            onClick: () => { if (hasOcrText) doCopy(reconstructParagraphs(ocrData!.lines) || ocrData!.text); },
            disabled: !hasOcrText,
        },
        ...(tableRows ? [{
            key: "copy_table",
            icon: Table2,
            label: t("float.copy_table"),
            onClick: () => doCopy(tableToTsv(tableRows)),
            accent: "emerald",
        } as Action] : []),
        ...(viewActive ? [{
            key: "reset",
            icon: RotateCcw,
            label: t("float.reset_view"),
            onClick: handleReset,
        } as Action] : []),
        ...(onClose ? [{
            key: "close",
            icon: X,
            label: t("float.close"),
            onClick: onClose,
            accent: "red",
        } as Action] : []),
    ];

    return (
        <div
            ref={rootRef}
            // NOTE: no `select-none` on the root — when the root forbids
            // selection, Chromium sometimes refuses to extend a drag-select
            // across the empty regions between OCR lines (where the root's
            // own style bleeds through). Children that should not be
            // selectable (controls, pills, background) opt out individually.
            className="relative w-full h-full group overflow-hidden"
            onContextMenu={(e) => {
                const selection = window.getSelection();
                if (selection && selection.toString()) {
                    e.preventDefault();
                    setContextMenu({ x: e.clientX, y: e.clientY });
                }
            }}
            onClick={() => setContextMenu(null)}
        >
            {/* Drag-or-pan layer.
             * IMPORTANT: in the "no zoom, no window-drag" case we must NOT
             * render an event-catching div here — it would swallow mousemove
             * in the empty space between OCR lines and break native drag-select
             * that straddles multiple lines. When we do need a catcher, keep
             * only the specific button we care about and let everything else
             * fall through by not stopping propagation. */}
            {viewActive ? (
                <div
                    className="absolute inset-0 z-0 cursor-grab active:cursor-grabbing select-none"
                    onMouseDown={(e) => { if (e.button === 0 && !e.altKey) beginPan(e); }}
                />
            ) : allowWindowDrag ? (
                <div
                    data-tauri-drag-region
                    className="absolute inset-0 z-0 cursor-move select-none"
                    onMouseDown={(e) => { if (e.button === 1) beginPan(e); }}
                />
            ) : null}

            {/* Image — transformed by view */}
            <div
                className="absolute inset-0 z-[1] pointer-events-none"
                style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.s})`, transformOrigin: '0 0' }}
            >
                <img
                    ref={imgRef}
                    src={imageSrc}
                    className={`w-full h-full pointer-events-none ${isStretched ? 'object-fill' : 'object-contain'}`}
                    alt=""
                />
            </div>

            <OCRLayer
                ocrData={ocrData}
                imgRef={imgRef}
                isStretched={isStretched}
                onCopyLine={doCopy}
                onCopyRegion={(lines) => {
                    const text = reconstructParagraphs(lines);
                    if (text) doCopy(text);
                }}
                onMultiSelectChange={setMultiSelected}
                clearMultiSelectToken={clearMultiToken}
                showConfidenceHeatmap={showHeatmap}
                searchHighlights={hits}
                viewScale={view.s}
                viewTx={view.tx}
                viewTy={view.ty}
            />

            {/* Top-right toolbar — driven by `toolbarActions` config above.
             * To add a new action, push a record into that array; no JSX
             * edit needed here. */}
            <div className="absolute top-2 right-2 z-20 flex gap-2">
                {toolbarActions.map(a => (
                    <IconButton
                        key={a.key}
                        icon={a.icon}
                        label={a.label}
                        onClick={a.onClick}
                        active={a.active}
                        disabled={a.disabled}
                        accent={a.accent}
                        iconClassName={a.iconClassName}
                    />
                ))}
            </div>

            {/* Search bar */}
            {searchOpen && (
                <GlassSurface
                    variant="pill"
                    animate
                    className="absolute top-2 left-1/2 -translate-x-1/2 z-30 slide-in-from-top-2"
                >
                    <div className="flex items-center gap-1 px-2.5 py-1">
                        <SearchGlassIcon size={14} className="text-white/70 flex-shrink-0 ml-0.5" />
                        <input
                            ref={searchInputRef}
                            value={searchQuery}
                            onChange={(e) => { setSearchQuery(e.target.value); setSearchCurrent(0); }}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") { e.preventDefault(); if (e.shiftKey) prevHit(); else nextHit(); }
                                else if (e.key === "Escape") { e.preventDefault(); setSearchOpen(false); setSearchQuery(""); }
                            }}
                            placeholder={t("float.search_placeholder")}
                            className="bg-transparent text-white text-sm outline-none w-40 placeholder:text-white/40"
                        />
                        <span className="text-[11px] text-white/55 whitespace-nowrap px-1 tabular-nums">
                            {hits.length > 0 ? `${searchCurrent + 1} / ${hits.length}` : searchQuery ? "0 / 0" : ""}
                        </span>
                        <button onClick={prevHit} disabled={hits.length === 0} aria-label="previous" className="w-6 h-6 rounded-md hover:bg-white/10 disabled:opacity-30 flex items-center justify-center transition-colors">
                            <ChevronUp size={14} className="text-white" />
                        </button>
                        <button onClick={nextHit} disabled={hits.length === 0} aria-label="next" className="w-6 h-6 rounded-md hover:bg-white/10 disabled:opacity-30 flex items-center justify-center transition-colors">
                            <ChevronDown size={14} className="text-white" />
                        </button>
                        <button onClick={() => { setSearchOpen(false); setSearchQuery(""); }} aria-label="close" className="w-6 h-6 rounded-md hover:bg-white/15 flex items-center justify-center transition-colors">
                            <X size={14} className="text-white" />
                        </button>
                    </div>
                </GlassSurface>
            )}

            {/* OCR-done hint (suppressed while multi-select active) */}
            {ocrData && ocrData.lines.length > 0 && !hintDismissed && multiSelected.length === 0 && !searchOpen && (
                <GlassSurface
                    variant="pill"
                    animate
                    className="absolute bottom-6 left-1/2 -translate-x-1/2 z-30 slide-in-from-bottom-2 pointer-events-auto max-w-[92%]"
                >
                    <div className="flex items-center gap-2.5 pl-1 pr-1.5 py-1 text-sm" onClick={(e) => e.stopPropagation()}>
                        <span
                            className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0"
                            style={{
                                background: "linear-gradient(135deg, #10b981 0%, #059669 100%)",
                                boxShadow: "0 0 0 1px rgba(255,255,255,0.18) inset, 0 0 10px rgba(16,185,129,0.45)",
                            }}
                        >
                            <Check size={14} strokeWidth={3.2} className="text-white" />
                        </span>
                        <span className="font-medium whitespace-nowrap text-white/95">{t("preview.ocr_done")}</span>
                        <button
                            onClick={() => { if (ocrData.text) { doCopy(reconstructParagraphs(ocrData.lines) || ocrData.text); setHintDismissed(true); } }}
                            className="ml-1 px-3 py-1 rounded-full bg-indigo-500 hover:bg-indigo-400 active:bg-indigo-600 transition-colors font-semibold flex items-center gap-1.5 flex-shrink-0 text-white text-[12.5px]"
                        >
                            <Copy size={12} /> {t("preview.copy_all_ocr")}
                        </button>
                        <button
                            onClick={() => setHintDismissed(true)}
                            aria-label="dismiss"
                            className="w-7 h-7 rounded-full hover:bg-white/15 active:bg-white/20 transition-colors flex items-center justify-center flex-shrink-0 text-white/80"
                        >
                            <X size={13} />
                        </button>
                    </div>
                </GlassSurface>
            )}

            {/* Multi-select pill */}
            {multiSelected.length > 0 && !searchOpen && (
                <GlassSurface
                    variant="pill"
                    accent="indigo"
                    animate
                    className="absolute bottom-6 left-1/2 -translate-x-1/2 z-30 slide-in-from-bottom-2 pointer-events-auto"
                >
                    <div className="flex items-center gap-2 pl-3.5 pr-1.5 py-1 text-sm" onClick={(e) => e.stopPropagation()}>
                        <span
                            className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                            style={{ background: "#818cf8", boxShadow: "0 0 6px rgba(129,140,248,0.8)" }}
                        />
                        <span className="font-medium whitespace-nowrap text-white/95 tabular-nums">
                            {t("preview.multi_selected").replace("{n}", String(multiSelected.length))}
                        </span>
                        <button
                            onClick={() => { const text = reconstructParagraphs(multiSelected); if (text) doCopy(text); }}
                            className="ml-1 px-2.5 py-1 rounded-full bg-indigo-500 hover:bg-indigo-400 active:bg-indigo-600 transition-colors font-semibold flex items-center gap-1.5 text-white text-[12.5px]"
                        >
                            <Copy size={12} /> {t("preview.copy_all_ocr")}
                        </button>
                        <button
                            onClick={() => { setMultiSelected([]); setClearMultiToken(tok => tok + 1); }}
                            aria-label="clear selection"
                            className="w-7 h-7 rounded-full hover:bg-white/15 active:bg-white/20 transition-colors flex items-center justify-center text-white/80"
                        >
                            <X size={13} />
                        </button>
                    </div>
                </GlassSurface>
            )}

            {/* Smart links — small chips; lightweight individual buttons
             * rather than GlassSurface wrappers (too granular to justify). */}
            {smartLinks.length > 0 && !multiSelected.length && !searchOpen && (
                <div className="absolute bottom-20 left-2 right-2 z-20 flex flex-wrap gap-1.5 pointer-events-auto justify-center">
                    {smartLinks.slice(0, 8).map((l, i) => {
                        const Icon = l.type === "url" ? LinkIcon : l.type === "email" ? Mail : Phone;
                        return (
                            <button
                                key={i}
                                onClick={() => doCopy(l.value)}
                                className="px-2.5 py-1 rounded-full backdrop-blur-md text-white text-[11.5px] flex items-center gap-1.5 max-w-[220px] truncate transition-all hover:bg-indigo-500"
                                style={{
                                    background: "rgba(24,24,27,0.75)",
                                    boxShadow: GLASS_TOKENS.hairline,
                                }}
                                title={`${t("float.copy_smart_link")}: ${l.value}`}
                            >
                                <Icon size={12} className="flex-shrink-0 text-white/80" />
                                <span className="truncate">{l.value}</span>
                            </button>
                        );
                    })}
                </div>
            )}

            {/* Loading indicator */}
            {isOcrLoading && !ocrData && (
                <div className="absolute inset-0 z-40 flex items-center justify-center pointer-events-none">
                    <GlassSurface variant="pill" animate accent="indigo">
                        <div className="flex items-center gap-3 px-5 py-2.5">
                            <Search size={18} className="animate-spin text-indigo-400" />
                            <span className="text-sm font-semibold text-white">{t("float.ocr_running")}</span>
                        </div>
                    </GlassSurface>
                </div>
            )}

            {/* Copy toast — emerald-accented success pill. The dark glass body
             * keeps WCAG AAA contrast against any image; the emerald bubble
             * carries "success" semantics independently of background. */}
            {copySuccess && (
                <GlassSurface
                    variant="pill"
                    animate
                    className="absolute bottom-24 left-1/2 -translate-x-1/2 z-50 slide-in-from-bottom-2 pointer-events-none"
                    style={{
                        boxShadow: [
                            GLASS_TOKENS.topHighlight,
                            GLASS_TOKENS.hairline,
                            "0 12px 36px -10px rgba(0,0,0,0.6)",
                            "0 4px 10px -2px rgba(16,185,129,0.35)",
                        ].join(", "),
                    }}
                >
                    <div className="flex items-center gap-2.5 pl-1 pr-4 py-1">
                        <div
                            className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0"
                            style={{
                                background: "linear-gradient(135deg, #10b981 0%, #059669 100%)",
                                boxShadow: "0 0 0 1px rgba(255,255,255,0.18) inset, 0 0 12px rgba(16,185,129,0.55)",
                            }}
                        >
                            <Check size={14} strokeWidth={3.2} className="text-white" />
                        </div>
                        <span className="text-[13px] font-semibold tracking-wide text-white">
                            {t("float.copied")}
                        </span>
                    </div>
                </GlassSurface>
            )}

            {/* Context menu (right-click on selection) */}
            {contextMenu && (
                <GlassSurface
                    variant="card"
                    animate
                    className="fixed z-[100] min-w-[140px]"
                    style={{
                        left: Math.min(contextMenu.x, window.innerWidth - 150),
                        top: Math.min(contextMenu.y, window.innerHeight - 50),
                    }}
                >
                    <button
                        className="w-full text-left px-4 py-2.5 text-sm text-zinc-100 hover:bg-indigo-500 hover:text-white transition-colors flex items-center gap-3 font-medium"
                        onClick={(e) => {
                            e.stopPropagation();
                            const selection = window.getSelection();
                            const selectedText = selection ? selection.toString() : "";
                            if (selectedText) doCopy(selectedText);
                            setContextMenu(null);
                        }}
                    >
                        <Copy size={15} /> {t("float.copy_text")}
                    </button>
                </GlassSurface>
            )}

            <div className="absolute inset-0 border border-white/10 pointer-events-none rounded-sm z-[5]" />
        </div>
    );
}

export default ImageOcrViewer;
