import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { CheckCircle, XCircle } from "lucide-react";
import { appWindow } from "@tauri-apps/api/window";
import { t, initLocale } from "../i18n";
initLocale();

const PromptModal = () => {
    useEffect(() => {
        // Automatically focus on window show
        appWindow.setFocus();
    }, []);

    const handleDecision = async (decision: "always" | "once" | "ignore") => {
        try {
            await invoke("user_prompt_decision", { decision });
            await appWindow.hide();
        } catch (error) {
            console.error("Failed to submit decision:", error);
        }
    };

    return (
        <div className="w-screen h-screen flex items-center justify-center bg-transparent select-none overflow-hidden p-2">
            <div className="w-full h-full bg-[#161b22] rounded-2xl border border-gray-700 shadow-2xl flex flex-col p-4 animate-in zoom-in-95 duration-200">
                <div className="flex items-center gap-3 text-[var(--accent-color)] mb-2">
                    <CheckCircle size={20} className="animate-pulse" />
                    <h3 className="font-bold text-[var(--text-main)] text-sm tracking-wide">{t('prompt.title')}</h3>
                </div>
                <p className="text-xs text-[var(--text-dim)] mb-4 flex-1">
                    {t('prompt.body')}
                </p>

                <div className="flex flex-col gap-2">
                    <button
                        onClick={() => handleDecision("always")}
                        className="w-full py-2 px-3 rounded-xl text-xs font-bold bg-[var(--accent-color)] text-white hover:bg-[var(--accent-light)] transition-all shadow-lg flex items-center justify-center gap-2"
                    >
                        <CheckCircle size={14} />
                        {t('prompt.always')}
                    </button>
                    <div className="flex gap-2">
                        <button
                            onClick={() => handleDecision("once")}
                            className="flex-1 py-2 px-3 rounded-xl text-xs font-medium bg-[var(--input-bg)] border border-[var(--border-color)] text-[var(--text-main)] hover:bg-[var(--panel-hover)] transition-all flex items-center justify-center gap-1.5"
                        >
                            <CheckCircle size={14} />
                            {t('prompt.once')}
                        </button>
                        <button
                            onClick={() => handleDecision("ignore")}
                            className="flex-1 py-2 px-3 rounded-xl text-xs font-medium bg-[var(--input-bg)] border border-[var(--border-color)] text-[var(--text-dim)] hover:text-red-400 transition-all flex items-center justify-center gap-1.5"
                        >
                            <XCircle size={14} />
                            {t('prompt.ignore')}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default PromptModal;
