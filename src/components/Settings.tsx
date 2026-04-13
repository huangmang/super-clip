import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { message as tauriMessage } from "@tauri-apps/api/dialog";
import { X, Settings as SettingsIcon, Save, RotateCcw } from "lucide-react";
import Tooltip from "./Tooltip";

interface SettingsProps {
    isOpen: boolean;
    onClose: () => void;
}

const Settings = ({ isOpen, onClose }: SettingsProps) => {
    const [shortcut, setShortcut] = useState("CmdOrCtrl+Shift+V");
    const [miniShortcut, setMiniShortcut] = useState("CmdOrCtrl+M");
    const [retentionDays, setRetentionDays] = useState(0); // 0 = Always keep
    const [enableDoubleCtrl, setEnableDoubleCtrl] = useState(true);
    const [autoLaunch, setAutoLaunch] = useState(false);
    const [interceptMode, setInterceptMode] = useState<"always" | "ask">("ask");
    const [isRecording, setIsRecording] = useState<'main' | 'mini' | false>(false);
    const [tempKeys, setTempKeys] = useState<string[]>([]);
    const [tempMiniKeys, setTempMiniKeys] = useState<string[]>([]);
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState<{ text: string, type: 'success' | 'error' } | null>(null);

    useEffect(() => {
        if (isOpen) {
            invoke<string>("get_shortcut").then(setShortcut).catch(console.error);
            invoke<string | null>("get_setting", { key: "retention_days" })
                .then(val => {
                    if (val) setRetentionDays(parseInt(val));
                })
                .catch(console.error);

            invoke<string | null>("get_setting", { key: "enable_double_ctrl" })
                .then(val => {
                    if (val !== null) setEnableDoubleCtrl(val === "true");
                })
                .catch(console.error);

            invoke<string | null>("get_setting", { key: "mini_shortcut" })
                .then(val => {
                    if (val) setMiniShortcut(val);
                })
                .catch(console.error);

            invoke<string | null>("get_setting", { key: "always_intercept_clip" })
                .then(val => {
                    if (val) setInterceptMode(val as "always" | "ask");
                })
                .catch(console.error);

            invoke<boolean>("plugin:autostart|is_enabled").then(setAutoLaunch).catch(console.error);
        }
    }, [isOpen]);

    useEffect(() => {
        if (!isRecording) return;

        const handleKeyDown = (e: KeyboardEvent) => {
            e.preventDefault();

            const keys: string[] = [];
            if (e.ctrlKey) keys.push("Ctrl");
            if (e.altKey) keys.push("Alt");
            if (e.shiftKey) keys.push("Shift");
            if (e.metaKey) keys.push("Command");

            // Avoid adding just modifiers
            if (!["Control", "Alt", "Shift", "Meta"].includes(e.key)) {
                let key = e.key.toUpperCase();
                if (key === " ") key = "Space";
                keys.push(key);
                if (isRecording === 'main') {
                    setTempKeys(keys);
                } else if (isRecording === 'mini') {
                    setTempMiniKeys(keys);
                }
                setIsRecording(false);
            } else {
                if (isRecording === 'main') {
                    setTempKeys(keys);
                } else if (isRecording === 'mini') {
                    setTempMiniKeys(keys);
                }
            }
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [isRecording]);

    const handleSave = async () => {
        const finalShortcut = tempKeys.length > 0 ? tempKeys.join("+") : shortcut;
        const finalMiniShortcut = tempMiniKeys.length > 0 ? tempMiniKeys.join("+") : miniShortcut;
        setSaving(true);
        setMessage(null);
        try {
            // Update Shortcut
            await invoke("update_shortcut", { shortcutStr: finalShortcut, isMinimalist: false });
            // Update Retention
            await invoke("apply_retention_policy", { days: retentionDays });
            // Update Double Ctrl
            await invoke("toggle_double_ctrl", { enabled: enableDoubleCtrl });
            // Update Mini Shortcut & Re-register
            await invoke("update_shortcut", { shortcutStr: finalMiniShortcut, isMinimalist: true });
            await invoke("save_setting", { key: "always_intercept_clip", value: interceptMode });

            if (autoLaunch) {
                await invoke("plugin:autostart|enable").catch(console.error);
            } else {
                await invoke("plugin:autostart|disable").catch(console.error);
            }

            setShortcut(finalShortcut);
            setMiniShortcut(finalMiniShortcut);
            setMessage({ text: "设置已保存", type: 'success' });
            
            // Show Native Confirmation Window using Tauri API!
            await tauriMessage("✅ 所有配置项已成功保存且立即生效！", {
                title: "Super Clip 设置",
                type: "info"
            });
            
            onClose();
        } catch (error) {
            setMessage({ text: `保存失败: ${error}`, type: 'error' });
        } finally {
            setSaving(false);
        }
    };


    if (!isOpen) return null;

    const retentionOptions = [
        { label: "永久保留", value: 0 },
        { label: "1 天", value: 1 },
        { label: "7 天", value: 7 },
        { label: "30 天", value: 30 },
        { label: "90 天", value: 90 },
    ];

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4 animate-in fade-in duration-200">
            <div
                className="bg-[var(--panel-bg)] w-full max-w-md rounded-2xl border border-[var(--border-color)] shadow-2xl overflow-hidden flex flex-col animate-in zoom-in-95 duration-200"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="p-4 border-b border-[var(--border-color)] flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <SettingsIcon className="text-indigo-400 w-5 h-5" />
                        <h2 className="font-semibold text-[var(--text-main)]">设置</h2>
                    </div>
                    <Tooltip text="关闭设置" position="bottom">
                        <button onClick={onClose} className="text-[var(--text-dim)] hover:text-[var(--text-main)] transition-colors p-1 hover:bg-[var(--panel-hover)] rounded">
                            <X size={20} />
                        </button>
                    </Tooltip>
                </div>

                {/* Content */}
                <div className="p-6 space-y-8 max-h-[70vh] overflow-y-auto custom-scrollbar">
                    {/* Hotkey Section */}
                    <div className="space-y-3">
                        <label className="text-xs font-medium text-[var(--text-dim)] uppercase tracking-wider block">
                            全局呼出快捷键
                        </label>
                        <div className="flex gap-2">
                            <div
                                className={`flex-1 flex items-center justify-center gap-2 bg-[var(--bg-color)]/40 border h-12 rounded-xl transition-all ${isRecording === 'main'
                                    ? "border-indigo-500 shadow-[0_0_15px_rgba(99,102,241,0.2)] ring-2 ring-indigo-500/20"
                                    : "border-[var(--border-color)]"
                                    }`}
                            >
                                {isRecording === 'main' ? (
                                    <div className="flex items-center gap-2">
                                        <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
                                        <span className="text-sm font-mono text-indigo-400">
                                            {tempKeys.length > 0 ? tempKeys.join(" + ") : "录制中..."}
                                        </span>
                                    </div>
                                ) : (
                                    <span className="text-sm font-mono text-[var(--text-main)]">
                                        {tempKeys.length > 0 ? tempKeys.join(" + ") : shortcut}
                                    </span>
                                )}
                            </div>
                            <Tooltip text="点击并按下新按键组合" position="top">
                                <button
                                    onClick={() => {
                                        setIsRecording('main');
                                        setTempKeys([]);
                                    }}
                                    className={`px-4 rounded-xl border flex items-center justify-center transition-all ${isRecording === 'main'
                                        ? "bg-indigo-600 border-indigo-500 text-white"
                                        : "bg-[var(--input-bg)] border-[var(--border-color)] text-[var(--text-dim)] hover:bg-[var(--panel-hover)] hover:text-[var(--text-main)]"
                                        }`}
                                >
                                    <RotateCcw size={18} />
                                </button>
                            </Tooltip>
                        </div>
                        <p className="text-[10px] text-gray-600 italic">
                            提示: 点击右侧按钮并按下新的按键组合进行录制。
                        </p>
                    </div>

                    {/* Minimalist Mode Shortcut */}
                    <div className="space-y-3 border-t border-white/5 pt-6">
                        <label className="text-xs font-medium text-[var(--text-dim)] uppercase tracking-wider block">
                            极简模式快捷键
                        </label>
                        <div className="flex gap-2">
                            <div
                                className={`flex-1 flex items-center justify-center gap-2 bg-[var(--bg-color)]/40 border h-12 rounded-xl transition-all ${isRecording === 'mini'
                                    ? "border-cyan-500 shadow-[0_0_15px_rgba(6,182,212,0.2)] ring-2 ring-cyan-500/20"
                                    : "border-[var(--border-color)]"
                                    }`}
                            >
                                {isRecording === 'mini' ? (
                                    <div className="flex items-center gap-2">
                                        <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
                                        <span className="text-sm font-mono text-cyan-400">
                                            {tempMiniKeys.length > 0 ? tempMiniKeys.join(" + ") : "录制中..."}
                                        </span>
                                    </div>
                                ) : (
                                    <span className="text-sm font-mono text-[var(--text-main)]">
                                        {tempMiniKeys.length > 0 ? tempMiniKeys.join(" + ") : miniShortcut}
                                    </span>
                                )}
                            </div>
                            <Tooltip text="设定极简模式按键" position="top">
                                <button
                                    onClick={() => {
                                        setIsRecording('mini');
                                        setTempMiniKeys([]);
                                    }}
                                    className={`px-4 rounded-xl border flex items-center justify-center transition-all ${isRecording === 'mini'
                                        ? "bg-cyan-600 border-cyan-500 text-white"
                                        : "bg-[var(--input-bg)] border-[var(--border-color)] text-[var(--text-dim)] hover:bg-[var(--panel-hover)] hover:text-[var(--text-main)]"
                                        }`}
                                >
                                    <RotateCcw size={18} />
                                </button>
                            </Tooltip>
                        </div>
                        <p className="text-[10px] text-gray-600 italic">
                            应用内按此快捷键切换极简搜索模式。默认 Ctrl+M。
                        </p>
                    </div>

                    {/* Double Ctrl Toggle & Auto Launch */}
                    <div className="space-y-3 pt-2">
                        <div className="flex items-center justify-between p-3 bg-[var(--input-bg)] rounded-xl border border-[var(--border-color)]">
                            <div className="space-y-0.5">
                                <label className="text-sm font-medium text-[var(--text-main)] block">
                                    开机自动启动
                                </label>
                                <p className="text-[10px] text-[var(--text-dim)]">
                                    跟随系统启动时自动运行并在后台驻留
                                </p>
                            </div>
                            <button
                                onClick={() => setAutoLaunch(!autoLaunch)}
                                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${autoLaunch ? "bg-indigo-600" : "bg-[var(--border-color)]"
                                    }`}
                            >
                                <span
                                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${autoLaunch ? "translate-x-6" : "translate-x-1"
                                        }`}
                                />
                            </button>
                        </div>
                        
                        <div className="flex items-center justify-between p-3 bg-[var(--input-bg)] rounded-xl border border-[var(--border-color)]">
                            <div className="space-y-0.5">
                                <label className="text-sm font-medium text-[var(--text-main)] block">
                                    新剪贴板内容提示
                                </label>
                                <p className="text-[10px] text-[var(--text-dim)]">
                                    开启时每次在外部 `Ctrl+C` 都会弹窗询问是否收录
                                </p>
                            </div>
                            <button
                                onClick={() => setInterceptMode(interceptMode === "ask" ? "always" : "ask")}
                                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${interceptMode === "ask" ? "bg-indigo-600" : "bg-[var(--border-color)]"
                                    }`}
                            >
                                <span
                                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${interceptMode === "ask" ? "translate-x-6" : "translate-x-1"
                                        }`}
                                />
                            </button>
                        </div>
                        <div className="flex items-center justify-between p-3 bg-[var(--input-bg)] rounded-xl border border-[var(--border-color)]">
                            <div className="space-y-0.5">
                                <label className="text-sm font-medium text-[var(--text-main)] block">
                                    双击 Ctrl 呼出窗口
                                </label>
                                <p className="text-[10px] text-[var(--text-dim)]">
                                    快速按下两次 Ctrl 键来显示或隐藏主窗口 (Windows 专享)
                                </p>
                            </div>
                            <button
                                onClick={() => setEnableDoubleCtrl(!enableDoubleCtrl)}
                                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${enableDoubleCtrl ? "bg-indigo-600" : "bg-[var(--border-color)]"
                                    }`}
                            >
                                <span
                                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${enableDoubleCtrl ? "translate-x-6" : "translate-x-1"
                                        }`}
                                />
                            </button>
                        </div>
                    </div>

                    {/* Auto Cleanup Section */}
                    <div className="space-y-3 border-t border-white/5 pt-6">
                        <label className="text-xs font-medium text-[var(--text-dim)] uppercase tracking-wider block">
                            自动清理历史记录
                        </label>
                        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                            {retentionOptions.map((opt) => (
                                <button
                                    key={opt.value}
                                    onClick={() => setRetentionDays(opt.value)}
                                    className={`py-2 px-2 rounded-lg text-xs font-medium transition-all ${retentionDays === opt.value
                                        ? "bg-indigo-600 text-white shadow-lg shadow-indigo-500/20"
                                        : "bg-[var(--input-bg)] text-[var(--text-dim)] hover:bg-[var(--panel-hover)] hover:text-[var(--text-main)] border border-[var(--border-color)]"
                                        }`}
                                >
                                    {opt.label}
                                </button>
                            ))}
                        </div>
                        <p className="text-[10px] text-gray-600 italic">
                            注意: 置顶 📌 和 收藏 ⭐ 的内容永远不会被自动清理。
                        </p>
                    </div>

                    {message && (
                        <div className={`p-3 rounded-lg text-xs flex items-center gap-2 animate-in slide-in-from-top-1 duration-200 ${message.type === 'success' ? "bg-green-500/10 text-green-400 border border-green-500/20" : "bg-red-500/10 text-red-400 border border-red-500/20"
                            }`}>
                            <div className={`w-1.5 h-1.5 rounded-full ${message.type === 'success' ? "bg-green-500" : "bg-red-500"}`} />
                            {message.text}
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="p-4 bg-[var(--header-bg)]/20 border-t border-[var(--border-color)] flex gap-3">
                    <button
                        onClick={onClose}
                        className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium text-[var(--text-dim)] hover:text-[var(--text-main)] hover:bg-[var(--panel-hover)] transition-all"
                    >
                        取消
                    </button>
                    <button
                        onClick={handleSave}
                        disabled={saving}
                        className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium bg-indigo-600 hover:bg-indigo-500 text-white transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-indigo-500/20"
                    >
                        {saving ? (
                            <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        ) : (
                            <Save size={18} />
                        )}
                        保存设置
                    </button>
                </div>
            </div>
        </div>
    );
};

export default Settings;
