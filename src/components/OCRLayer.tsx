import { useState, useEffect, useRef } from "react";

interface OcrLine {
    text: string;
    confidence: number;
    box_coords?: number[][]; // [[x1,y1], [x2,y2], [x3,y3], [x4,y4]]
}

export interface OcrResult {
    text: string;
    lines: OcrLine[];
}

interface OCRLayerProps {
    ocrData: OcrResult | null;
    imgRef: React.RefObject<HTMLImageElement>;
    isStretched?: boolean;
}

export const OCRLayer = ({ ocrData, imgRef, isStretched }: OCRLayerProps) => {
    const layerRef = useRef<HTMLDivElement>(null);
    const [scale, setScale] = useState({ x: 1, y: 1 });
    const [offset, setOffset] = useState({ x: 0, y: 0 });
    const [highlightRects, setHighlightRects] = useState<{ left: number, top: number, width: number, height: number }[]>([]);

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

                let renderWidth = width;
                let renderHeight = height;
                let offsetX = 0;
                let offsetY = 0;

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

        const handleResize = () => {
            animationFrameId = window.requestAnimationFrame(updateScale);
        };

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

    // Handle precise custom selection highlighting to bypass Chromium's buggy absolute union selection boxes
    useEffect(() => {
        const handleSelectionChange = () => {
            const selection = window.getSelection();
            if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
                setHighlightRects([]);
                return;
            }

            try {
                const range = selection.getRangeAt(0);
                const rects = Array.from(range.getClientRects());

                if (!layerRef.current) return;
                const containerRect = layerRef.current.getBoundingClientRect();

                // Normalize rects relative to the OCR Layer container
                const normalizedRects = rects.map(rect => ({
                    left: rect.left - containerRect.left,
                    top: rect.top - containerRect.top,
                    width: rect.width,
                    height: rect.height
                }));

                setHighlightRects(normalizedRects);
            } catch (err) {
                setHighlightRects([]);
            }
        };

        document.addEventListener("selectionchange", handleSelectionChange);
        return () => document.removeEventListener("selectionchange", handleSelectionChange);
    }, []);

    if (!ocrData) return null;

    // Spatially sort lines so Chromium multi-select dragging naturally flows Top-To-Bottom, Left-To-Right
    const sortedLines = [...ocrData.lines].filter(l => l.box_coords && l.box_coords.length >= 2).sort((a, b) => {
        const aMinY = Math.min(...a.box_coords!.map(p => p[1]));
        const bMinY = Math.min(...b.box_coords!.map(p => p[1]));
        if (Math.abs(aMinY - bMinY) > 10) return aMinY - bMinY; // Sort by Y
        const aMinX = Math.min(...a.box_coords!.map(p => p[0]));
        const bMinX = Math.min(...b.box_coords!.map(p => p[0]));
        return aMinX - bMinX; // Then by X on same line
    });

    return (
        <div ref={layerRef} className="ocr-no-select-flash absolute inset-0 z-10 overflow-hidden pointer-events-none select-none" style={{ userSelect: "none" }}>
            {/* Custom High-Fidelity Highlights */}
            {highlightRects.map((rect, i) => (
                <div
                    key={`hl-${i}`}
                    className="absolute bg-blue-500/30 pointer-events-none mix-blend-multiply transition-none"
                    style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
                />
            ))}

            {/* Invisible Structural Text layer */}
            {sortedLines.map((line, lineIdx) => {
                const validCoords = line.box_coords!.filter(p => p && p.length >= 2);
                if (validCoords.length === 0) return null;

                const minX = Math.min(...validCoords.map(p => p[0]));
                const maxX = Math.max(...validCoords.map(p => p[0]));
                const minY = Math.min(...validCoords.map(p => p[1]));
                const maxY = Math.max(...validCoords.map(p => p[1]));

                const lineBox = { x: minX, y: minY, x2: maxX, y2: maxY };
                const left = offset.x + lineBox.x * scale.x;
                const top = offset.y + lineBox.y * scale.y;
                const width = (lineBox.x2 - lineBox.x) * scale.x;
                const height = (lineBox.y2 - lineBox.y) * scale.y;

                if (width <= 0 || height <= 0) return null;

                // Adjust font size based on bounding box height to fit well
                const fontSize = height * 0.8; 

                return (
                    <div
                        key={lineIdx}
                        // Use selection:bg-transparent to hide the buggy Chromium native bounding box flash
                        className="absolute text-transparent select-text cursor-text pointer-events-auto selection:bg-transparent selection:text-transparent hover:bg-white/5 transition-colors"
                        style={{
                            left: `${left}px`,
                            top: `${top}px`,
                            width: `${width}px`,
                            height: `${height}px`,
                            lineHeight: `${height}px`,
                            fontSize: `${fontSize}px`,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                        }}
                        title={line.text} // Provide title for accessibility/tooltip
                    >
                        {line.text}
                    </div>
                );
            })}
        </div>
    );
};

export default OCRLayer;
