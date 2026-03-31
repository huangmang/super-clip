import { useEffect, useState, useRef } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/tauri";
import { X, Search, Maximize, Minimize, Copy } from "lucide-react";
import { appWindow, LogicalSize } from "@tauri-apps/api/window";
import OCRLayer, { OcrResult } from "./OCRLayer";

const FloatImage = () => {
    const [imageSrc, setImageSrc] = useState<string | null>(null);
    const [rawPath, setRawPath] = useState<string | null>(null);
    const [clipId, setClipId] = useState<number | null>(null);
    const [showControls, setShowControls] = useState(false);
    const [ocrData, setOcrData] = useState<OcrResult | null>(null);
    const [isOcrLoading, setIsOcrLoading] = useState(false);
    const [isStretched, setIsStretched] = useState(false);
    const [copySuccess, setCopySuccess] = useState(false);
    const [contextMenu, setContextMenu] = useState<{ x: number, y: number } | null>(null);
    const imgRef = useRef<HTMLImageElement>(null);

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const path = params.get("path");
        const id = params.get("id");
        if (path) {
            setRawPath(path);
            setImageSrc(convertFileSrc(path));
        }
        if (id) {
            setClipId(parseInt(id));
            // Trigger OCR automatically for the floated image
            if (path) {
                performOCR_manual(parseInt(id), path);
            }
        }

        // Set transparent background for the html/body
        document.documentElement.style.background = "transparent";
        document.body.style.background = "transparent";

        const handleWheel = async (e: WheelEvent) => {
            if (e.ctrlKey) return; // Prevent default zoom
            const factor = e.deltaY > 0 ? 0.9 : 1.1;
            const size = await appWindow.innerSize();
            const factorX = (await appWindow.scaleFactor()) || 1;

            // Convert physical to logical for setSize
            const currentW = size.width / factorX;
            const currentH = size.height / factorX;

            await appWindow.setSize(new LogicalSize(currentW * factor, currentH * factor));
        };

        const handleKeyDown = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && (e.code === "KeyC" || e.key.toLowerCase() === "c")) {
                const selection = window.getSelection();
                const selectedText = selection ? selection.toString() : "";

                if (selectedText) {
                    e.preventDefault();
                    console.log("[FLOAT] Copying selected text:", selectedText);
                    invoke("copy_to_clipboard", { content: selectedText, kind: "text" })
                        .then(() => showToast())
                        .catch(err => console.error("[FLOAT] Selection copy failed:", err));
                }
            }

            if (e.key === "Escape") {
                appWindow.close();
            }
        };

        window.addEventListener("keydown", handleKeyDown);
        window.addEventListener("wheel", handleWheel);

        // Add copy event listener for native selection
        const handleNativeCopy = (_e: ClipboardEvent) => {
            // If there's a native selection, we allow it to proceed 
            // but we show the toast.
            const selection = window.getSelection();
            if (selection && selection.toString()) {
                showToast();
            }
        };
        window.addEventListener("copy", handleNativeCopy);

        return () => {
            window.removeEventListener("wheel", handleWheel);
            window.removeEventListener("keydown", handleKeyDown);
            window.removeEventListener("copy", handleNativeCopy);
        };
    }, [ocrData]); // Update listeners when ocrData changes

    const showToast = () => {
        setCopySuccess(true);
        setTimeout(() => setCopySuccess(false), 2000);
    };

    const performOCR_manual = async (id?: number, path?: string) => {
        const targetId = id || clipId;
        const targetPath = path || rawPath;
        if (!targetPath || !targetId || isOcrLoading) return;
        setIsOcrLoading(true);
        try {
            const result = await invoke<OcrResult>("perform_ocr", { id: targetId, path: targetPath });
            setOcrData(result);
        } catch (error) {
            console.error("OCR failed:", error);
        } finally {
            setIsOcrLoading(false);
        }
    };

    const handleCopy = async (text: string) => {
        await invoke("copy_to_clipboard", { content: text, kind: "text" });
        showToast();
    };


    const handleReset = async () => {
        if (!imgRef.current) return;
        const { naturalWidth, naturalHeight } = imgRef.current;
        // Reset to a reasonable size while maintaining natural aspect ratio
        const displayWidth = Math.min(naturalWidth, 800);
        const displayHeight = (displayWidth / naturalWidth) * naturalHeight;
        await appWindow.setSize(new LogicalSize(displayWidth, displayHeight));
    };

    if (!imageSrc) return null;

    return (
    <div
        className="relative w-screen h-screen group overflow-hidden"
        onMouseEnter={() => setShowControls(true)}
        onMouseLeave={() => setShowControls(false)}
        onContextMenu={(e) => {
            const selection = window.getSelection();
            if (selection && selection.toString()) {
                // Let native selection context menu handle it if it exists, 
                // or show our custom one if we want full control.
                // For now, let's show our custom one to bridge the gap.
                e.preventDefault();
                setContextMenu({ x: e.clientX, y: e.clientY });
            }
        }}
        onClick={() => setContextMenu(null)}
    >
        {/* Drag Region - Restricted to non-selectable area if possible */}
        <div
            data-tauri-drag-region
            className="absolute inset-0 z-0 cursor-move select-none"
        />

        {/* Image */}
        <img
            ref={imgRef}
            src={imageSrc}
            className={`w-full h-full pointer-events-none transition-all duration-100 ${isStretched ? 'object-fill' : 'object-contain'}`}
            alt="Floated clip"
            onDoubleClick={handleReset}
        />

        {/* OCR Layer */}
        <OCRLayer
            ocrData={ocrData}
            imgRef={imgRef}
            isStretched={isStretched}
        />

        {/* Controls Overlay */}
        {(showControls || isOcrLoading) && (
            <div className="absolute top-2 right-2 z-20 flex gap-2 animate-in fade-in duration-200">
                <button
                    onClick={() => setIsStretched(!isStretched)}
                    className={`p-1.5 rounded-lg backdrop-blur-md transition-all border border-white/10 text-white ${isStretched ? 'bg-indigo-500' : 'bg-black/50 hover:bg-indigo-500'}`}
                    title={isStretched ? "Restrain to Aspect Ratio" : "Stretch to Fill"}
                >
                    {isStretched ? <Minimize size={16} /> : <Maximize size={16} />}
                </button>
                <button
                    onClick={() => performOCR_manual()}
                    disabled={isOcrLoading}
                    className={`p-1.5 rounded-lg backdrop-blur-md transition-all border border-white/10 text-white ${isOcrLoading
                        ? 'bg-indigo-500/80 animate-pulse'
                        : 'bg-black/50 hover:bg-indigo-500'
                        }`}
                    title="Recognize Text (OCR)"
                >
                    <Search size={16} className={isOcrLoading ? "animate-spin" : ""} />
                </button>
                <button
                    onClick={() => appWindow.close()}
                    className="p-1.5 bg-black/50 hover:bg-red-500 text-white rounded-lg backdrop-blur-md transition-all border border-white/10"
                    title="Close"
                >
                    <X size={16} />
                </button>
            </div>
        )}
        {/* Copy Success Toast */}
        {copySuccess && (
            <div className="absolute bottom-10 left-1/2 -translate-x-1/2 z-50 animate-in fade-in zoom-in duration-300">
                <div className="flex items-center gap-2 px-4 py-2 bg-green-500 text-white rounded-full shadow-2xl border border-white/20 backdrop-blur-md">
                    <div className="w-5 h-5 rounded-full bg-white/20 flex items-center justify-center">
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M5 13l4 4L19 7" /></svg>
                    </div>
                    <span className="text-sm font-bold tracking-wide">复制成功 / Copied!</span>
                </div>
            </div>
        )}

        {/* Custom Context Menu */}
        {contextMenu && (
            <div
                className="fixed z-[100] bg-black/80 backdrop-blur-xl border border-white/10 rounded-xl shadow-2xl overflow-hidden animate-in fade-in zoom-in duration-100 min-w-[140px]"
                style={{ left: Math.min(contextMenu.x, window.innerWidth - 150), top: Math.min(contextMenu.y, window.innerHeight - 50) }}
            >
                <button
                    className="w-full text-left px-4 py-3 text-sm text-gray-200 hover:bg-indigo-500 hover:text-white transition-all flex items-center gap-3 font-medium active:scale-95"
                    onClick={(e) => {
                        e.stopPropagation();
                        const selection = window.getSelection();
                        const selectedText = selection ? selection.toString() : "";

                        if (selectedText) {
                            handleCopy(selectedText);
                        }
                        setContextMenu(null);
                    }}
                >
                    <Copy size={16} /> 复制文本 (Copy)
                </button>
            </div>
        )}

        {/* Outline for frameless feel */}
        <div className="absolute inset-0 border border-white/10 pointer-events-none rounded-sm" />
    </div>
    );
};

export default FloatImage;
