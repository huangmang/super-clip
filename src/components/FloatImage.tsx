import { useEffect, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/tauri";
import { appWindow } from "@tauri-apps/api/window";
import { OcrResult } from "./OCRLayer";
import ImageOcrViewer from "./ImageOcrViewer";
import { initLocale } from "../i18n";
initLocale();

/**
 * Thin Tauri-window shell around <ImageOcrViewer>. The viewer handles all the
 * actual OCR UX (selection, multi-select, zoom/pan, heatmap, search, etc.).
 */
const FloatImage = () => {
    const [imageSrc, setImageSrc] = useState<string | null>(null);
    const [rawPath, setRawPath] = useState<string | null>(null);
    const [clipId, setClipId] = useState<number | null>(null);
    const [ocrData, setOcrData] = useState<OcrResult | null>(null);
    const [isOcrLoading, setIsOcrLoading] = useState(false);

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const path = params.get("path");
        const id = params.get("id");
        if (path) { setRawPath(path); setImageSrc(convertFileSrc(path)); }
        if (id) {
            const numId = parseInt(id);
            setClipId(numId);
            if (path) performOcr(numId, path);
        }
        document.documentElement.style.background = "transparent";
        document.body.style.background = "transparent";
    }, []);

    const performOcr = async (id?: number, path?: string) => {
        const targetId = id ?? clipId;
        const targetPath = path ?? rawPath;
        if (!targetPath || !targetId || isOcrLoading) return;
        setIsOcrLoading(true);
        try {
            const result = await invoke<OcrResult>("perform_ocr", { id: targetId, path: targetPath });
            setOcrData(result);
        } catch (err) {
            console.error("OCR failed:", err);
        } finally {
            setIsOcrLoading(false);
        }
    };

    const copyToClipboard = async (text: string) => {
        await invoke("copy_to_clipboard", { content: text, kind: "text" });
    };

    if (!imageSrc) return null;

    return (
        <div className="w-screen h-screen">
            <ImageOcrViewer
                imageSrc={imageSrc}
                ocrData={ocrData}
                isOcrLoading={isOcrLoading}
                onRequestOcr={() => performOcr()}
                onCopy={copyToClipboard}
                onClose={() => appWindow.close()}
                allowWindowResize
                allowWindowDrag
            />
        </div>
    );
};

export default FloatImage;
