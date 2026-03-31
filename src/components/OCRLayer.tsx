import { useState, useEffect } from "react";

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
    const [scale, setScale] = useState({ x: 1, y: 1 });
    const [offset, setOffset] = useState({ x: 0, y: 0 });

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

    if (!ocrData) return null;

    return (
        <div className="absolute inset-0 z-10 overflow-hidden" style={{ userSelect: "text" }}>
            {ocrData.lines.map((line, lineIdx) => {
                if (!line.box_coords || !line.box_coords.length) return null;

                const validCoords = line.box_coords.filter(p => p && p.length >= 2);
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
                // Usually height corresponds roughly to line-height/font-size
                const fontSize = height * 0.8; 

                return (
                    <div
                        key={lineIdx}
                        className="absolute text-transparent select-text cursor-text selection:bg-indigo-500/40 selection:text-transparent hover:bg-white/5 transition-colors"
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
