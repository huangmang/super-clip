import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { save as saveDialog, open as openDialog, confirm as confirmDialog } from "@tauri-apps/api/dialog";
import { X, Settings as SettingsIcon, Save, RotateCcw, Globe, Download, Upload } from "lucide-react";
import Tooltip from "./Tooltip";
import { t, getLocale, setLocale, type Locale } from "../i18n";

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
    const [ignoredApps, setIgnoredApps] = useState<string[]>([]);
    const [newIgnoredApp, setNewIgnoredApp] = useState("");
    const [locale, setLocaleState] = useState<Locale>(getLocale());
    const [dataBusy, setDataBusy] = useState<"export" | "import" | false>(false);

    const handleExport = async () => {
        if (dataBusy) return;
        try {
            const ts = new Date();
            const stamp = `${ts.getFullYear()}${String(ts.getMonth() + 1).padStart(2, "0")}${String(ts.getDate()).padStart(2, "0")}-${String(ts.getHours()).padStart(2, "0")}${String(ts.getMinutes()).padStart(2, "0")}`;
            const path = await saveDialog({
                defaultPath: `super-clip-backup-${stamp}.json`,
                filters: [{ name: "JSON", extensions: ["json"] }],
            });
            if (!path) return;
            setDataBusy("export");
            const res = await invoke<{ count: number; size_bytes: number }>("export_clips_to_json", { path });
            const sizeKb = Math.max(1, Math.round(res.size_bytes / 1024));
            setMessage({ text: t('settings.export_success').replace("{count}", String(res.count)).replace("{size}", `${sizeKb} KB`), type: "success" });
            setTimeout(() => setMessage(null), 3500);
        } catch (e) {
            setMessage({ text: String(e), type: "error" });
            setTimeout(() => setMessage(null), 4500);
        } finally {
            setDataBusy(false);
        }
    };

    const handleImport = async () => {
        if (dataBusy) return;
        try {
            const picked = await openDialog({
                multiple: false,
                filters: [{ name: "JSON", extensions: ["json"] }],
            });
            if (!picked || Array.isArray(picked)) return;
            const confirmed = await confirmDialog(t('settings.import_confirm'), { title: "Super Clip", type: "info" });
            if (!confirmed) return;
            setDataBusy("import");
            const res = await invoke<{ imported: number; skipped: number; snippets_imported: number; errors: number }>(
                "import_clips_from_json", { path: picked }
            );
            setMessage({
                text: t('settings.import_success')
                    .replace("{added}", String(res.imported))
                    .replace("{skipped}", String(res.skipped))
                    .replace("{snippets}", String(res.snippets_imported))
                    .replace("{errors}", String(res.errors)),
                type: res.errors > 0 ? "error" : "success",
            });
            setTimeout(() => setMessage(null), 5000);
        } catch (e) {
            setMessage({ text: String(e), type: "error" });
            setTimeout(() => setMessage(null), 4500);
        } finally {
            setDataBusy(false);
        }
    };

    // Snippets
    interface Snippet { id: number; name: string; content: string; trigger_text?: string | null; created_at: string; }
    const [snippets, setSnippets] = useState<Snippet[]>([]);
    const [snippetName, setSnippetName] = useState("");
    const [snippetContent, setSnippetContent] = useState("");
    const [snippetTrigger, setSnippetTrigger] = useState("");
    const [editingSnippetId, setEditingSnippetId] = useState<number | null>(null);
    const [settingsTab, setSettingsTab] = useState<"general" | "snippets">("general");

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

            invoke<Snippet[]>("get_snippets").then(setSnippets).catch(console.error);

            invoke<string | null>("get_setting", { key: "ignored_apps" })
                .then(val => {
                    if (val) {
                        try { setIgnoredApps(JSON.parse(val)); } catch { setIgnoredApps([]); }
                    }
                })
                .catch(console.error);
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
            setMessage({ text: t('settings.saved'), type: 'success' });
            // Native OS dialog removed — the inline `setMessage` toast already
            // tells the user it saved, and stacking a modal on top forces a
            // second click before the settings panel can close.
            onClose();
        } catch (error) {
            setMessage({ text: t('settings.save_failed', { e: String(error) }), type: 'error' });
        } finally {
            setSaving(false);
        }
    };


    if (!isOpen) return null;

    const retentionOptions = [
        { label: t('settings.retention_forever'), value: 0 },
        { label: t('settings.retention_1d'),       value: 1 },
        { label: t('settings.retention_7d'),       value: 7 },
        { label: t('settings.retention_30d'),      value: 30 },
        { label: t('settings.retention_90d'),      value: 90 },
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
                        <h2 className="font-semibold text-[var(--text-main)]">{t('settings.title')}</h2>
                    </div>
                    <Tooltip text={t('settings.close')} position="bottom">
                        <button onClick={onClose} className="text-[var(--text-dim)] hover:text-[var(--text-main)] transition-colors p-1 hover:bg-[var(--panel-hover)] rounded">
                            <X size={20} />
                        </button>
                    </Tooltip>
                </div>

                {/* Tab Switcher + Language Toggle */}
                <div className="flex border-b border-[var(--border-color)]">
                    <button onClick={() => setSettingsTab("general")} className={`flex-1 py-2 text-xs font-bold uppercase tracking-wider transition-colors ${settingsTab === "general" ? "text-indigo-400 border-b-2 border-indigo-400" : "text-[var(--text-dim)] hover:text-[var(--text-main)]"}`}>{t('settings.tab_general')}</button>
                    <button onClick={() => setSettingsTab("snippets")} className={`flex-1 py-2 text-xs font-bold uppercase tracking-wider transition-colors ${settingsTab === "snippets" ? "text-indigo-400 border-b-2 border-indigo-400" : "text-[var(--text-dim)] hover:text-[var(--text-main)]"}`}>{t('settings.tab_snippets')}</button>
                    <button
                        onClick={() => {
                            const next = locale === 'zh' ? 'en' : 'zh';
                            setLocale(next);
                            setLocaleState(next);
                            invoke("save_setting", { key: "locale", value: next }).catch(console.error);
                        }}
                        className="px-3 py-2 text-[10px] font-bold text-[var(--text-dim)] hover:text-indigo-400 transition-colors flex items-center gap-1.5 shrink-0"
                    >
                        <Globe size={12} />
                        {locale === 'zh' ? 'EN' : '中'}
                    </button>
                </div>

                {/* Content */}
                <div className="p-6 space-y-8 max-h-[70vh] overflow-y-auto custom-scrollbar">

                {settingsTab === "snippets" ? (
                    <div className="space-y-4">
                        <div className="space-y-3">
                            <input
                                type="text"
                                placeholder="Snippet name"
                                value={snippetName}
                                onChange={(e) => setSnippetName(e.target.value)}
                                className="w-full bg-[var(--input-bg)] border border-[var(--border-color)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500/50"
                            />
                            <textarea
                                placeholder="Snippet content..."
                                value={snippetContent}
                                onChange={(e) => setSnippetContent(e.target.value)}
                                rows={4}
                                className="w-full bg-[var(--input-bg)] border border-[var(--border-color)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500/50 font-mono resize-none"
                            />
                            <input
                                type="text"
                                placeholder="Trigger prefix (optional, e.g. ;;email)"
                                value={snippetTrigger}
                                onChange={(e) => setSnippetTrigger(e.target.value)}
                                className="w-full bg-[var(--input-bg)] border border-[var(--border-color)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500/50"
                            />
                            <button
                                onClick={async () => {
                                    if (!snippetName.trim() || !snippetContent.trim()) return;
                                    if (editingSnippetId) {
                                        await invoke("update_snippet", { id: editingSnippetId, name: snippetName, content: snippetContent, triggerText: snippetTrigger || null });
                                    } else {
                                        await invoke("create_snippet", { name: snippetName, content: snippetContent, triggerText: snippetTrigger || null });
                                    }
                                    setSnippetName(""); setSnippetContent(""); setSnippetTrigger(""); setEditingSnippetId(null);
                                    invoke<Snippet[]>("get_snippets").then(setSnippets);
                                }}
                                className="w-full py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-bold transition-all"
                            >
                                {editingSnippetId ? "Update Snippet" : "Add Snippet"}
                            </button>
                        </div>

                        {snippets.length > 0 && (
                            <div className="space-y-2 border-t border-[var(--border-color)] pt-4">
                                {snippets.map((s) => (
                                    <div key={s.id} className="flex items-start gap-3 p-3 bg-[var(--input-bg)] rounded-lg border border-[var(--border-color)] group">
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2">
                                                <span className="text-sm font-bold text-[var(--text-main)]">{s.name}</span>
                                                {s.trigger_text && (
                                                    <span className="px-1.5 py-0.5 bg-indigo-500/10 text-indigo-400 rounded text-[10px] font-mono">{s.trigger_text}</span>
                                                )}
                                            </div>
                                            <p className="text-[11px] text-[var(--text-dim)] mt-1 truncate font-mono">{s.content}</p>
                                        </div>
                                        <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                            <button
                                                onClick={() => { setEditingSnippetId(s.id); setSnippetName(s.name); setSnippetContent(s.content); setSnippetTrigger(s.trigger_text || ""); }}
                                                className="p-1.5 text-[var(--text-dim)] hover:text-indigo-400 transition-colors"
                                            >Edit</button>
                                            <button
                                                onClick={async () => { await invoke("delete_snippet", { id: s.id }); invoke<Snippet[]>("get_snippets").then(setSnippets); }}
                                                className="p-1.5 text-[var(--text-dim)] hover:text-red-400 transition-colors"
                                            >Del</button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                ) : (
                <>
                    {/* Hotkey Section */}
                    <div className="space-y-3">
                        <label className="text-xs font-medium text-[var(--text-dim)] uppercase tracking-wider block">
                            {t('settings.hotkey_main')}
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
                                            {tempKeys.length > 0 ? tempKeys.join(" + ") : t('settings.recording')}
                                        </span>
                                    </div>
                                ) : (
                                    <span className="text-sm font-mono text-[var(--text-main)]">
                                        {tempKeys.length > 0 ? tempKeys.join(" + ") : shortcut}
                                    </span>
                                )}
                            </div>
                            <Tooltip text={t('settings.hotkey_record_tip')} position="top">
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
                            {t('settings.hotkey_help')}
                        </p>
                    </div>

                    {/* Minimalist Mode Shortcut */}
                    <div className="space-y-3 border-t border-white/5 pt-6">
                        <label className="text-xs font-medium text-[var(--text-dim)] uppercase tracking-wider block">
                            {t('settings.hotkey_mini')}
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
                                            {tempMiniKeys.length > 0 ? tempMiniKeys.join(" + ") : t('settings.recording')}
                                        </span>
                                    </div>
                                ) : (
                                    <span className="text-sm font-mono text-[var(--text-main)]">
                                        {tempMiniKeys.length > 0 ? tempMiniKeys.join(" + ") : miniShortcut}
                                    </span>
                                )}
                            </div>
                            <Tooltip text={t('settings.hotkey_mini_tip')} position="top">
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
                            {t('settings.hotkey_mini_help')}
                        </p>
                    </div>

                    {/* Double Ctrl Toggle & Auto Launch */}
                    <div className="space-y-3 pt-2">
                        <div className="flex items-center justify-between p-3 bg-[var(--input-bg)] rounded-xl border border-[var(--border-color)]">
                            <div className="space-y-0.5">
                                <label className="text-sm font-medium text-[var(--text-main)] block">
                                    {t('settings.autostart')}
                                </label>
                                <p className="text-[10px] text-[var(--text-dim)]">
                                    {t('settings.autostart_help')}
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
                                    {t('settings.intercept_prompt')}
                                </label>
                                <p className="text-[10px] text-[var(--text-dim)]">
                                    {t('settings.intercept_prompt_help')}
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
                                    {t('settings.double_ctrl')}
                                </label>
                                <p className="text-[10px] text-[var(--text-dim)]">
                                    {t('settings.double_ctrl_help')}
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
                            {t('settings.retention_title')}
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
                            {t('settings.retention_help')}
                        </p>
                    </div>

                    {/* Privacy: Ignored Apps */}
                    <div className="space-y-2">
                        <label className="text-xs font-bold text-gray-400 uppercase tracking-wider block">
                            {t('settings.ignored_title')}
                        </label>
                        <p className="text-[10px] text-gray-600">
                            {t('settings.ignored_help')}
                        </p>
                        <div className="flex gap-2">
                            <input
                                type="text"
                                placeholder="e.g. KeePass.exe"
                                value={newIgnoredApp}
                                onChange={(e) => setNewIgnoredApp(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter" && newIgnoredApp.trim()) {
                                        const updated = [...ignoredApps, newIgnoredApp.trim()];
                                        setIgnoredApps(updated);
                                        invoke("save_setting", { key: "ignored_apps", value: JSON.stringify(updated) });
                                        setNewIgnoredApp("");
                                    }
                                }}
                                className="flex-1 bg-[var(--input-bg)] border border-[var(--border-color)] rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:border-indigo-500/50"
                            />
                            <button
                                onClick={() => {
                                    if (newIgnoredApp.trim()) {
                                        const updated = [...ignoredApps, newIgnoredApp.trim()];
                                        setIgnoredApps(updated);
                                        invoke("save_setting", { key: "ignored_apps", value: JSON.stringify(updated) });
                                        setNewIgnoredApp("");
                                    }
                                }}
                                className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-bold"
                            >
                                Add
                            </button>
                        </div>
                        {/* Quick-add suggestions */}
                        <div className="flex gap-1.5 flex-wrap">
                            {["KeePass.exe", "1Password.exe", "Bitwarden.exe", "LastPass.exe"].filter(a => !ignoredApps.includes(a)).map(app => (
                                <button
                                    key={app}
                                    onClick={() => {
                                        const updated = [...ignoredApps, app];
                                        setIgnoredApps(updated);
                                        invoke("save_setting", { key: "ignored_apps", value: JSON.stringify(updated) });
                                    }}
                                    className="px-2 py-0.5 bg-[var(--input-bg)] border border-[var(--border-color)] rounded text-[10px] text-[var(--text-dim)] hover:border-indigo-500/50 hover:text-indigo-400 transition-colors"
                                >
                                    + {app}
                                </button>
                            ))}
                        </div>
                        {/* Current list */}
                        {ignoredApps.length > 0 && (
                            <div className="flex gap-1.5 flex-wrap mt-1">
                                {ignoredApps.map((app, i) => (
                                    <span key={i} className="flex items-center gap-1 px-2 py-1 bg-red-500/10 border border-red-500/20 rounded-lg text-[10px] text-red-400 font-medium">
                                        {app}
                                        <button
                                            onClick={() => {
                                                const updated = ignoredApps.filter((_, idx) => idx !== i);
                                                setIgnoredApps(updated);
                                                invoke("save_setting", { key: "ignored_apps", value: JSON.stringify(updated) });
                                            }}
                                            className="hover:text-red-300 ml-0.5"
                                        >
                                            ×
                                        </button>
                                    </span>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* Data Management — Export / Import JSON */}
                    <div className="space-y-2 border-t border-white/5 pt-6">
                        <label className="text-xs font-bold text-gray-400 uppercase tracking-wider block">
                            {t('settings.data_management')}
                        </label>
                        <p className="text-[10px] text-gray-600">
                            {t('settings.data_management_desc')}
                        </p>
                        <div className="flex gap-2">
                            <button
                                onClick={handleExport}
                                disabled={!!dataBusy}
                                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-xs font-medium bg-[var(--input-bg)] border border-[var(--border-color)] text-[var(--text-main)] hover:border-indigo-500/50 hover:text-indigo-400 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                <Download size={14} />
                                {dataBusy === "export" ? t('settings.exporting') : t('settings.export')}
                            </button>
                            <button
                                onClick={handleImport}
                                disabled={!!dataBusy}
                                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-xs font-medium bg-[var(--input-bg)] border border-[var(--border-color)] text-[var(--text-main)] hover:border-indigo-500/50 hover:text-indigo-400 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                <Upload size={14} />
                                {dataBusy === "import" ? t('settings.importing') : t('settings.import')}
                            </button>
                        </div>
                    </div>

                </>
                )}

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
                        {t('action.cancel')}
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
                        {t('settings.save_button')}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default Settings;
