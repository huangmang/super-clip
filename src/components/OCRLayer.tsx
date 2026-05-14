import { useState, useEffect, useRef, useMemo } from "react";
import { GlassSurface, GLASS_TOKENS } from "./GlassSurface";

export interface CharBox {
    text: string;
    x: number;
    y: number;
    w: number;
    h: number;
    confidence?: number; // CTC peak probability, 0..1
}

export interface OcrLine {
    text: string;
    confidence: number;
    box_coords?: number[][]; // [[x1,y1], [x2,y2], [x3,y3], [x4,y4]]
    chars?: CharBox[];       // optional per-char positions (RapidOCR CTC path)
}

export interface OcrResult {
    text: string;
    lines: OcrLine[];
}

interface OCRLayerProps {
    ocrData: OcrResult | null;
    imgRef: React.RefObject<HTMLImageElement>;
    isStretched?: boolean;
    onCopyLine?: (text: string) => void;
    onCopyRegion?: (lines: OcrLine[]) => void;
    onMultiSelectChange?: (lines: OcrLine[]) => void;
    clearMultiSelectToken?: number; // parent bumps to force-clear selection
    // When true, render a red tint on low-confidence chars so the user can see
    // which glyphs the model is unsure about. Opacity = (1 - conf). No-op when
    // per-char confidence data isn't available (Windows OCR fallback).
    showConfidenceHeatmap?: boolean;
    // Highlight character ranges matched by the search (Ctrl+F). Each entry
    // references a line (by sorted index) and a char-range within that line.
    searchHighlights?: { lineIdx: number; charStart: number; charEnd: number; isCurrent: boolean }[];
    // World-coord transform applied to the image. OCRLayer sits OUTSIDE the
    // transformed wrapper so selection rects / marquee can stay in screen
    // coords, but we fold these into every line/char position so overlays
    // track the zoomed image.
    viewScale?: number;
    viewTx?: number;
    viewTy?: number;
    // When true, plain clicks toggle multi-select instead of copy. Lets the
    // bottom action-bar drive multi-select without forcing users to learn
    // the Ctrl+click shortcut.
    multiSelectMode?: boolean;
}

// Keep font family stable across canvas measurement and DOM rendering so
// transparent-text selection rects align with the image characters.
const OCR_FONT_FAMILY = 'sans-serif';
const LOW_CONF = 0.6;              // lines below this get an amber tag
const DBLCLICK_WINDOW_MS = 220;    // delay single-click action for dblclick detection
const DRAG_THRESHOLD_PX = 4;       // movement above this → drag, not click

let _measureCtx: CanvasRenderingContext2D | null = null;
const measureTextWidth = (text: string, fontSize: number): number => {
    if (!_measureCtx) {
        const canvas = document.createElement('canvas');
        _measureCtx = canvas.getContext('2d');
    }
    if (!_measureCtx) return 0;
    _measureCtx.font = `${fontSize}px ${OCR_FONT_FAMILY}`;
    return _measureCtx.measureText(text).width;
};

type Marquee = { startX: number; startY: number; curX: number; curY: number };

export const OCRLayer = ({ ocrData, imgRef, isStretched, onCopyLine, onCopyRegion, onMultiSelectChange, clearMultiSelectToken, showConfidenceHeatmap, searchHighlights, viewScale = 1, viewTx = 0, viewTy = 0, multiSelectMode = false }: OCRLayerProps) => {
    const layerRef = useRef<HTMLDivElement>(null);
    const [scale, setScale] = useState({ x: 1, y: 1 });
    const [offset, setOffset] = useState({ x: 0, y: 0 });
    const [highlightRects, setHighlightRects] = useState<{ left: number, top: number, width: number, height: number }[]>([]);
    const [marquee, setMarquee] = useState<Marquee | null>(null);
    const [selectedIdxs, setSelectedIdxs] = useState<Set<number>>(() => new Set());
    const mouseDownPos = useRef<{ x: number, y: number } | null>(null);
    const clickTimer = useRef<number | null>(null);
    // Custom hover tooltip. `title` attribute produces OS-native yellow
    // tooltips that ignore our dark theme — replace with a glass card
    // anchored to the hovered line.
    const [hoveredLine, setHoveredLine] = useState<{
        idx: number; left: number; top: number; height: number; maxWidth: number; text: string; conf: number; lowConf: boolean;
    } | null>(null);
    const hoverTimerRef = useRef<number | null>(null);

    // ── Derived: spatially sorted lines with pre-computed bbox ──────────
    // Single source for "which line is where". Every downstream consumer
    // (marquee hit-test, line render map, hover anchor, multi-select sync)
    // reads the cached `{ minX, maxX, minY, maxY }` instead of re-doing
    // spread/Math.min on every access. Recomputes only when ocrData
    // identity changes — so pan/zoom ticks are free of this work.
    type EnrichedLine = OcrLine & { bbox: { minX: number; maxX: number; minY: number; maxY: number } };
    const sortedLines = useMemo<EnrichedLine[]>(() => {
        if (!ocrData) return [];
        const out: EnrichedLine[] = [];
        for (const line of ocrData.lines) {
            if (!line.box_coords || line.box_coords.length < 2) continue;
            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            for (const p of line.box_coords) {
                if (!p || p.length < 2) continue;
                const x = p[0], y = p[1];
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
            if (!isFinite(minX)) continue;
            out.push({ ...line, bbox: { minX, maxX, minY, maxY } });
        }
        out.sort((a, b) => {
            if (Math.abs(a.bbox.minY - b.bbox.minY) > 10) return a.bbox.minY - b.bbox.minY;
            return a.bbox.minX - b.bbox.minX;
        });
        return out;
    }, [ocrData]);

    // ── Scale tracking: image natural → display coords ─────────────────
    useEffect(() => {
        let animationFrameId: number;
        const updateScale = () => {
            const img = imgRef.current;
            if (!img) return;
            const { naturalWidth, naturalHeight, width, height } = img;
            if (naturalWidth === 0) return;

            if (isStretched) {
                setScale({ x: width / naturalWidth, y: height / naturalHeight });
                setOffset({ x: 0, y: 0 });
            } else {
                const naturalRatio = naturalWidth / naturalHeight;
                const displayRatio = width / height;
                let renderWidth = width, renderHeight = height, offsetX = 0, offsetY = 0;
                if (naturalRatio > displayRatio) {
                    renderHeight = width / naturalRatio;
                    offsetY = (height - renderHeight) / 2;
                } else {
                    renderWidth = height * naturalRatio;
                    offsetX = (width - renderWidth) / 2;
                }
                setScale({ x: renderWidth / naturalWidth, y: renderHeight / naturalHeight });
                setOffset({ x: offsetX, y: offsetY });
            }
        };

        const handleResize = () => { animationFrameId = window.requestAnimationFrame(updateScale); };

        const img = imgRef.current;
        if (img) {
            if (img.complete) updateScale();
            img.addEventListener("load", updateScale);
            window.addEventListener("resize", handleResize);
        }
        return () => {
            if (img) img.removeEventListener("load", updateScale);
            window.removeEventListener("resize", handleResize);
            window.cancelAnimationFrame(animationFrameId);
        };
    }, [imgRef, ocrData, isStretched]);

    // ── Custom selection highlight (sidesteps Chromium's buggy union boxes) ──
    // rAF-throttled: selectionchange fires on every mouse move during a
    // drag-select (can be >60/sec). Coalescing to one update per frame
    // drops React re-renders from ~N to ~16/sec without changing what the
    // user sees — the highlight tracks the cursor smoothly either way.
    useEffect(() => {
        let rafId: number | null = null;
        let pending = false;
        const apply = () => {
            rafId = null;
            pending = false;
            const selection = window.getSelection();
            if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
                setHighlightRects([]);
                return;
            }
            // Non-trivial selection = user drag-selected or an auto-copy
            // just fired. Hide the hover tooltip so it doesn't race with
            // the highlight rects.
            setHoveredLine(null);
            if (hoverTimerRef.current) {
                window.clearTimeout(hoverTimerRef.current);
                hoverTimerRef.current = null;
            }
            try {
                const range = selection.getRangeAt(0);
                const rects = Array.from(range.getClientRects());
                if (!layerRef.current) return;
                const containerRect = layerRef.current.getBoundingClientRect();
                setHighlightRects(rects.map(r => ({
                    left: r.left - containerRect.left,
                    top: r.top - containerRect.top,
                    width: r.width,
                    height: r.height,
                })));
            } catch {
                setHighlightRects([]);
            }
        };
        const handleSelectionChange = () => {
            if (pending) return;
            pending = true;
            rafId = requestAnimationFrame(apply);
        };
        document.addEventListener("selectionchange", handleSelectionChange);
        return () => {
            document.removeEventListener("selectionchange", handleSelectionChange);
            if (rafId != null) cancelAnimationFrame(rafId);
        };
    }, []);

    // ── Marquee: Alt+drag anywhere over the layer selects a region ─────
    useEffect(() => {
        const onDown = (e: MouseEvent) => {
            if (!e.altKey || e.button !== 0) return;
            const el = layerRef.current;
            if (!el) return;
            const rect = el.getBoundingClientRect();
            if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) return;
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            setMarquee({ startX: x, startY: y, curX: x, curY: y });
            e.preventDefault();
            e.stopPropagation();
        };
        window.addEventListener("mousedown", onDown, true);
        return () => window.removeEventListener("mousedown", onDown, true);
    }, []);

    useEffect(() => {
        if (!marquee) return;
        const layerEl = layerRef.current;
        const onMove = (e: MouseEvent) => {
            if (!layerEl) return;
            const rect = layerEl.getBoundingClientRect();
            setMarquee(m => m && { ...m, curX: e.clientX - rect.left, curY: e.clientY - rect.top });
        };
        const onUp = () => {
            setMarquee(current => {
                if (current && ocrData && onCopyRegion) {
                    // Marquee rect in layer coords → image-natural coords
                    const x0 = Math.min(current.startX, current.curX);
                    const y0 = Math.min(current.startY, current.curY);
                    const x1 = Math.max(current.startX, current.curX);
                    const y1 = Math.max(current.startY, current.curY);
                    // Only fire for meaningful rectangles (reject stray clicks)
                    if (x1 - x0 >= 6 && y1 - y0 >= 6) {
                        const hits = sortedLines.filter(line => {
                            const { minX, maxX, minY, maxY } = line.bbox;
                            const lx0 = (offset.x + minX * scale.x) * viewScale + viewTx;
                            const ly0 = (offset.y + minY * scale.y) * viewScale + viewTy;
                            const lx1 = (offset.x + maxX * scale.x) * viewScale + viewTx;
                            const ly1 = (offset.y + maxY * scale.y) * viewScale + viewTy;
                            return !(lx1 < x0 || lx0 > x1 || ly1 < y0 || ly0 > y1);
                        });
                        if (hits.length > 0) onCopyRegion(hits);
                    }
                }
                return null;
            });
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp, { once: true });
        return () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
        };
    }, [marquee, ocrData, scale, offset, viewScale, viewTx, viewTy, onCopyRegion]);

    // ── Per-line click semantics ──────────────────────────────────────
    const handleLineMouseDown = (e: React.MouseEvent) => {
        if (e.altKey) return; // let the marquee handler take it
        if (e.detail === 1) {
            mouseDownPos.current = { x: e.clientX, y: e.clientY };
        }
    };

    const handleLineClick = (e: React.MouseEvent<HTMLDivElement>, line: OcrLine, lineIdx: number) => {
        if (e.altKey) return;

        // Multi-select trigger: explicit Ctrl/Cmd+click *or* the persistent
        // multi-select-mode toggle from the bottom action bar. The latter
        // lets users without keyboard fluency build a multi-line selection
        // by simply tapping each line.
        const wantsMultiToggle = e.ctrlKey || e.metaKey || multiSelectMode;
        if (wantsMultiToggle) {
            e.preventDefault();
            e.stopPropagation();
            if (clickTimer.current != null) {
                window.clearTimeout(clickTimer.current);
                clickTimer.current = null;
            }
            window.getSelection()?.removeAllRanges();
            setSelectedIdxs(prev => {
                const next = new Set(prev);
                if (next.has(lineIdx)) next.delete(lineIdx);
                else next.add(lineIdx);
                return next;
            });
            return;
        }

        // Plain click on a line discards any existing multi-select — user
        // switched modes — and falls through to the click/dbl-click flow below.
        if (selectedIdxs.size > 0) setSelectedIdxs(new Set());

        if (e.detail > 1) {
            if (clickTimer.current != null) {
                window.clearTimeout(clickTimer.current);
                clickTimer.current = null;
            }
            return;
        }
        const start = mouseDownPos.current;
        mouseDownPos.current = null;
        if (start) {
            const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y);
            if (moved >= DRAG_THRESHOLD_PX) return;
        }

        e.stopPropagation();
        const target = e.currentTarget;
        const text = line.text;

        if (clickTimer.current != null) window.clearTimeout(clickTimer.current);
        clickTimer.current = window.setTimeout(() => {
            clickTimer.current = null;
            const range = document.createRange();
            range.selectNodeContents(target);
            const sel = window.getSelection();
            sel?.removeAllRanges();
            sel?.addRange(range);
            onCopyLine?.(text);
        }, DBLCLICK_WINDOW_MS);
    };

    // Clear multi-select when parent bumps the token (e.g. user hit Esc or
    // explicitly cleared via the bottom-hint close button).
    useEffect(() => {
        if (clearMultiSelectToken !== undefined) setSelectedIdxs(new Set());
    }, [clearMultiSelectToken]);

    // Hide tooltip whenever the view changes (pan/zoom/new OCR) — anchor
    // coords would be stale and flicker in the wrong spot.
    useEffect(() => { setHoveredLine(null); }, [ocrData, viewScale, viewTx, viewTy]);
    useEffect(() => () => { if (hoverTimerRef.current) window.clearTimeout(hoverTimerRef.current); }, []);

    // Clear when OCR data itself changes — indices would point at stale lines.
    useEffect(() => { setSelectedIdxs(new Set()); }, [ocrData]);

    // Push multi-select state up to parent whenever it changes. Parent uses
    // this to render the bottom hint and intercept Ctrl+C.
    useEffect(() => {
        if (!onMultiSelectChange) return;
        const picked = Array.from(selectedIdxs)
            .sort((a, b) => a - b)
            .map(i => sortedLines[i])
            .filter((x): x is EnrichedLine => !!x);
        onMultiSelectChange(picked);
    // sortedLines re-derived from ocrData; tracking ocrData keeps us in sync
    // without re-firing on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedIdxs, ocrData]);

    if (!ocrData) return null;

    const marqueeRect = marquee && {
        left: Math.min(marquee.startX, marquee.curX),
        top: Math.min(marquee.startY, marquee.curY),
        width: Math.abs(marquee.curX - marquee.startX),
        height: Math.abs(marquee.curY - marquee.startY),
    };

    return (
        <div
            ref={layerRef}
            // IMPORTANT: no `user-select: none` on the layer root — Chromium
            // uses that flag to refuse extending an in-progress selection
            // across the element's bounds, which kills drag-select once the
            // mouse briefly crosses an empty region between OCR lines. The
            // line divs + per-line text span inside still opt in to selection.
            className="ocr-no-select-flash absolute inset-0 z-10 overflow-hidden pointer-events-none"
        >
            {/* Selection highlights. Tuned for universal visibility:
             *   • fill: rgba(99,102,241,0.55)  — saturated indigo, visible on
             *     black backdrops AND image content
             *   • inset 1px outline of brighter indigo-400 @ 0.9 → gives a
             *     crisp edge on any underlying color (photos, dark modals,
             *     light backgrounds all get a defined boundary)
             *   • no mix-blend-mode — multiply was invisible on near-black,
             *     screen was invisible on near-white; plain alpha is the only
             *     mode that works everywhere. */}
            {highlightRects.map((rect, i) => (
                <div
                    key={`hl-${i}`}
                    className="absolute pointer-events-none animate-in fade-in duration-150"
                    style={{
                        left: rect.left,
                        top: rect.top,
                        width: rect.width,
                        height: rect.height,
                        background: 'rgba(99, 102, 241, 0.18)',
                        borderRadius: 3,
                    }}
                />
            ))}

            {/* Lines */}
            {sortedLines.map((line, lineIdx) => {
                // Pre-computed bbox from the useMemo above — no Math.min/max
                // inside the hot render path.
                const { minX, maxX, minY, maxY } = line.bbox;
                // World coords = image-display coords × viewScale + viewTranslate
                const left = (offset.x + minX * scale.x) * viewScale + viewTx;
                const top = (offset.y + minY * scale.y) * viewScale + viewTy;
                const width = (maxX - minX) * scale.x * viewScale;
                const height = (maxY - minY) * scale.y * viewScale;
                if (width <= 0 || height <= 0) return null;

                const fontSize = height * 0.8;
                const lowConf = line.confidence > 0 && line.confidence < LOW_CONF;
                const selected = selectedIdxs.has(lineIdx);
                const borderCls = lowConf ? 'border-l-2 border-amber-400/60' : '';
                const selectedCls = selected ? 'bg-indigo-500/25 ring-2 ring-inset ring-indigo-400' : 'hover:bg-indigo-400/15 hover:ring-1 hover:ring-inset hover:ring-indigo-400/50';

                return (
                    <div
                        key={lineIdx}
                        className={`absolute text-transparent select-text cursor-pointer pointer-events-auto selection:bg-transparent selection:text-transparent transition-colors ${selectedCls} ${borderCls}`}
                        style={{
                            left: `${left}px`,
                            top: `${top}px`,
                            width: `${width}px`,
                            height: `${height}px`,
                            lineHeight: `${height}px`,
                            fontSize: `${fontSize}px`,
                            fontFamily: OCR_FONT_FAMILY,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                        }}
                        onMouseDown={handleLineMouseDown}
                        onClick={(e) => handleLineClick(e, line, lineIdx)}
                        onMouseEnter={() => {
                            if (hoverTimerRef.current) window.clearTimeout(hoverTimerRef.current);
                            const layerW = layerRef.current?.clientWidth ?? 800;
                            hoverTimerRef.current = window.setTimeout(() => {
                                setHoveredLine({
                                    idx: lineIdx,
                                    left,
                                    top,
                                    height,
                                    maxWidth: Math.min(520, Math.max(200, layerW - 32)),
                                    text: line.text,
                                    conf: line.confidence,
                                    lowConf,
                                });
                            }, 300);
                        }}
                        onMouseLeave={() => {
                            if (hoverTimerRef.current) {
                                window.clearTimeout(hoverTimerRef.current);
                                hoverTimerRef.current = null;
                            }
                            setHoveredLine(prev => (prev && prev.idx === lineIdx ? null : prev));
                        }}
                    >
                        {/* ── Per-char visual overlays (heatmap + search hits) ──
                         * pointer-events: none so they never interfere with
                         * native drag-select on the line-level text anchor. */}
                        {line.chars && line.chars.length > 0 && line.chars.map((ch, ci) => {
                            const chWorldX = (offset.x + ch.x * scale.x) * viewScale + viewTx;
                            const chWorldY = (offset.y + ch.y * scale.y) * viewScale + viewTy;
                            const cxDisp = chWorldX - left;
                            const cyDisp = chWorldY - top;
                            const cwDisp = ch.w * scale.x * viewScale;
                            const chDisp = ch.h * scale.y * viewScale;
                            const heatAlpha = showConfidenceHeatmap && ch.confidence !== undefined
                                ? Math.max(0, Math.min(0.7, 1 - ch.confidence))
                                : 0;
                            const matches = searchHighlights?.filter(h => h.lineIdx === lineIdx && ci >= h.charStart && ci < h.charEnd) ?? [];
                            const isHit = matches.length > 0;
                            const isCurrentHit = matches.some(m => m.isCurrent);
                            if (heatAlpha <= 0.04 && !isHit) return null;
                            return (
                                <span key={`ov-${ci}`} aria-hidden style={{
                                    position: 'absolute',
                                    left: `${cxDisp}px`,
                                    top: `${cyDisp}px`,
                                    width: `${cwDisp}px`,
                                    height: `${chDisp}px`,
                                    pointerEvents: 'none',
                                    background: isCurrentHit
                                        ? 'rgba(249, 115, 22, 0.75)'
                                        : isHit
                                            ? 'rgba(250, 204, 21, 0.55)'
                                            : `rgba(239, 68, 68, ${heatAlpha})`,
                                    outline: isCurrentHit ? '2px solid rgba(249, 115, 22, 1)' : undefined,
                                    mixBlendMode: isHit ? undefined : 'multiply',
                                }} />
                            );
                        })}

                        {/* ── Single per-line transparent text span = selection anchor ──
                         * One contiguous text node per line is what the browser's
                         * drag-select expects. scaleX calibration stretches the
                         * invisible text to match the image width so getClientRects
                         * returns rects aligned with the visible characters. */}
                        {(() => {
                            const measured = measureTextWidth(line.text, fontSize);
                            const sx = measured > 0 ? width / measured : 1;
                            return (
                                <span style={{
                                    display: 'inline-block',
                                    transform: `scaleX(${sx})`,
                                    transformOrigin: '0 0',
                                    whiteSpace: 'pre',
                                    userSelect: 'text',
                                    WebkitUserSelect: 'text',
                                }}>
                                    {line.text}
                                </span>
                            );
                        })()}
                    </div>
                );
            })}

            {/* Marquee rectangle */}
            {marqueeRect && (
                <div
                    className="absolute border-2 border-indigo-400 bg-indigo-400/10 pointer-events-none"
                    style={{
                        left: `${marqueeRect.left}px`,
                        top: `${marqueeRect.top}px`,
                        width: `${marqueeRect.width}px`,
                        height: `${marqueeRect.height}px`,
                    }}
                />
            )}

            {/* Custom hover tooltip — dark-glass "floating card" in the
             * Linear / Raycast / Apple preview idiom: deeply blurred backdrop,
             * single hairline ring, soft two-stop shadow for lift, and a
             * gradient top accent that picks up the hovered character.
             * Positioned above the line; flips below when near the top edge. */}
            {hoveredLine && (() => {
                const ABOVE_GAP = 10;
                const preferAbove = hoveredLine.top > 64;
                const anchorTop = preferAbove
                    ? hoveredLine.top - ABOVE_GAP
                    : hoveredLine.top + hoveredLine.height + ABOVE_GAP;
                const layerW = layerRef.current?.clientWidth ?? 800;
                const clampedLeft = Math.min(
                    Math.max(8, hoveredLine.left),
                    Math.max(8, layerW - hoveredLine.maxWidth - 8)
                );
                // Confidence dot colour — green / amber / red threshold.
                const conf = hoveredLine.conf;
                const dotColor = conf >= 0.85 ? '#10b981' : conf >= 0.6 ? '#f59e0b' : '#ef4444';
                const isShort = hoveredLine.text.length <= 3;
                const slideDir = preferAbove ? 'slide-in-from-bottom-1' : 'slide-in-from-top-1';

                // Caret: 18px from tooltip's left edge, colour matches the
                // card's edge gradient stop (imported from GLASS_TOKENS).
                const caretOffset = 18;
                const caretColor = preferAbove ? GLASS_TOKENS.edgeBottomSolid : GLASS_TOKENS.edgeTopSolid;

                return (
                    <div
                        className={`absolute z-40 pointer-events-none animate-in fade-in zoom-in-95 ${slideDir} duration-200 ease-out`}
                        style={{
                            left: clampedLeft,
                            top: anchorTop,
                            maxWidth: hoveredLine.maxWidth,
                            transform: preferAbove ? 'translateY(-100%)' : undefined,
                        }}
                    >
                        {/* Caret — sibling of the card so it extends past the
                         * card's `overflow-hidden`. Colour-matched to the
                         * adjacent gradient stop for a seamless join. */}
                        <div
                            className="absolute w-2.5 h-2.5 rotate-45 pointer-events-none"
                            style={{
                                left: caretOffset,
                                ...(preferAbove ? { bottom: -5 } : { top: -5 }),
                                background: caretColor,
                                backdropFilter: GLASS_TOKENS.blur,
                                WebkitBackdropFilter: GLASS_TOKENS.blur,
                                boxShadow: GLASS_TOKENS.hairline,
                                zIndex: 0,
                            }}
                        />

                        <GlassSurface variant="card" accent="indigo" style={{ zIndex: 1 }}>
                            <div className="px-3.5 py-2 flex items-start gap-2.5">
                                <div
                                    className="flex-1 min-w-0 text-[13px] leading-relaxed text-zinc-50 font-normal break-words tracking-normal"
                                    style={{ whiteSpace: 'pre-wrap', maxHeight: 180, overflow: 'hidden' }}
                                >
                                    {hoveredLine.text}
                                </div>

                                {!isShort && (
                                    <div className="flex items-center gap-1 flex-shrink-0 text-[10.5px] text-zinc-400 tabular-nums font-medium pt-[3px]">
                                        <span
                                            className="w-1.5 h-1.5 rounded-full"
                                            style={{ background: dotColor, boxShadow: `0 0 5px ${dotColor}80` }}
                                        />
                                        {Math.round(conf * 100)}%
                                    </div>
                                )}
                            </div>
                        </GlassSurface>
                    </div>
                );
            })()}
        </div>
    );
};

export default OCRLayer;
