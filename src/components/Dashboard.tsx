import { useState, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { t } from "../i18n";
import {
    LayoutDashboard,
    Type,
    Image as ImageIcon,
    Link as LinkIcon,
    Code as CodeIcon,
    FileText,
    BarChart3,
    Settings,
    Eraser,
    X,
    Sparkles,
    CheckCircle2,
    Mail,
    Phone,
    Network,
    Clock,
    Globe,
    Search,
    Hash,
    Monitor
} from "lucide-react";
import Tooltip from "./Tooltip";

interface Clip {
    id: number;
    content: string;
    type: string;
    is_favorite: boolean;
    is_pinned: boolean;
    created_at: string;
    source_app?: string | null;
    content_html?: string | null;
}

interface DashboardProps {
    onClose: () => void;
    onOpenSettings: () => void;
    onClearHistory: () => void;
    onFilter: (value: string, type?: string) => void;
    activeTab: string;
    timeFilter: string | null;
    clips: Clip[];
}

// `label` is resolved via t() at render time — declaring it here as a key
// keeps the array stable across language switches.
const RANGES = [
    { i18nKey: "dash.range_30m", value: "-30 minutes", key: "30m" },
    { i18nKey: "dash.range_2h",  value: "-2 hours",    key: "2h" },
    { i18nKey: "dash.range_3h",  value: "-3 hours",    key: "3h" },
    { i18nKey: "dash.range_1d",  value: "-1 day",      key: "1d" },
    { i18nKey: "dash.range_3d",  value: "-3 days",     key: "3d" },
    { i18nKey: "dash.range_all", value: "all",         key: "all" },
];

const TIME_FILTER_MS: Record<string, number> = {
    "30m": 30 * 60 * 1000,
    "2h": 2 * 60 * 60 * 1000,
    "3h": 3 * 60 * 60 * 1000,
    "1d": 24 * 60 * 60 * 1000,
    "3d": 3 * 24 * 60 * 60 * 1000,
};

const EXCLUDED_WORDS = new Set([" ","-","_","=","+","*","/","|","&","^","%","#","@","!","~","<",">",",",".","?",";",":","(",")"]);
const Dashboard = ({ onClose, onOpenSettings, onClearHistory, onFilter, activeTab: _activeTab, timeFilter, clips }: DashboardProps) => {
    const [selectedRange, setSelectedRange] = useState(RANGES.find(r => r.key === "1d") || RANGES[3]);

    useEffect(() => {
        if (timeFilter === null) {
            setSelectedRange(RANGES[5]);
        } else {
            const match = RANGES.find(r => r.key === timeFilter);
            if (match) setSelectedRange(match);
        }
    }, [timeFilter]);

    // Filter clips by selected time range — same logic as main list
    const rangeClips = useMemo(() => {
        if (selectedRange.key === "all") return clips;
        const ms = TIME_FILTER_MS[selectedRange.key];
        if (!ms) return clips;
        const now = Date.now();
        return clips.filter(c => now - new Date(c.created_at).getTime() <= ms);
    }, [clips, selectedRange]);

    // Compute stats from rangeClips — guaranteed to match main list
    const stats = useMemo(() => {
        const s: Record<string, number> = {};
        for (const c of rangeClips) {
            s[c.type] = (s[c.type] || 0) + 1;
        }
        return s;
    }, [rangeClips]);

    const sourceApps = useMemo(() => {
        const counts: Record<string, number> = {};
        for (const c of rangeClips) {
            const app = c.source_app || "Unknown";
            counts[app] = (counts[app] || 0) + 1;
        }
        return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 15) as [string, number][];
    }, [rangeClips]);

    const wordStats = useMemo(() => {
        const segmenter = new (Intl as any).Segmenter('zh', { granularity: 'word' });
        const ws: Record<string, number> = {};
        for (const c of rangeClips) {
            if (c.type === "image" || c.type === "file") continue;
            for (const { segment, isWordLike } of segmenter.segment(c.content)) {
                const word = segment.trim();
                if (isWordLike && word.length > 1 && !EXCLUDED_WORDS.has(word) && !/^[0-9]+$/.test(word) && !/^[a-zA-Z]$/.test(word)) {
                    ws[word] = (ws[word] || 0) + 1;
                }
            }
        }
        return ws;
    }, [rangeClips]);

    // Smart Discovery
    const discoveries = useMemo(() => {
        const results: Record<string, { value: string, icon: any, action?: string }[]> = { links: [], assets: [], tasks: [] };
        const patterns = {
            mail: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
            url: /https?:\/\/[^\s$.?#].[^\s]*/g,
            phone: /(?:\+?86)?\s?1[3-9]\d{9}/g,
            ip: /\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/g,
            task: /(?:TODO|FIXME|待办|任务|计划)[:：]\s*(.+)/gi
        };
        const seen = new Set();
        for (const c of rangeClips) {
            if (c.type === "image") continue;
            c.content.match(patterns.mail)?.forEach(m => { if (!seen.has(m)) { results.links.push({ value: m, icon: Mail }); seen.add(m); }});
            c.content.match(patterns.url)?.forEach(u => { if (!seen.has(u)) { results.links.push({ value: u, icon: Globe, action: 'open' }); seen.add(u); }});
            c.content.match(patterns.phone)?.forEach(p => { if (!seen.has(p)) { results.links.push({ value: p, icon: Phone }); seen.add(p); }});
            c.content.match(patterns.ip)?.forEach(ip => { if (!seen.has(ip)) { results.assets.push({ value: ip, icon: Network }); seen.add(ip); }});
            let match;
            const taskRegex = new RegExp(patterns.task);
            while ((match = taskRegex.exec(c.content)) !== null) {
                const task = match[1].trim();
                if (!seen.has(task)) { results.tasks.push({ value: task, icon: CheckCircle2 }); seen.add(task); }
            }
        }
        return results;
    }, [rangeClips]);

    // No more loading state needed — all computed from props
    const loading = false;

    const currentRangeTotal = Object.values(stats).reduce((a, b) => a + b, 0);

    // Labels are resolved via t() at render time so language switches don't
    // require remounting Dashboard.
    const typeConfig: Record<string, { label: string, icon: any, color: string, textColor: string, bgColor: string }> = {
        all:   { label: t('tab.all'),   icon: LayoutDashboard, color: "from-gray-500 to-gray-400",     textColor: "text-gray-400",    bgColor: "bg-white/5" },
        text:  { label: t('tab.text'),  icon: Type,            color: "from-blue-500 to-cyan-400",     textColor: "text-blue-400",    bgColor: "bg-blue-500/10" },
        image: { label: t('tab.image'), icon: ImageIcon,       color: "from-purple-500 to-pink-500",   textColor: "text-purple-400",  bgColor: "bg-purple-500/10" },
        link:  { label: t('tab.link'),  icon: LinkIcon,        color: "from-emerald-500 to-teal-400",  textColor: "text-emerald-400", bgColor: "bg-emerald-500/10" },
        code:  { label: t('tab.code'),  icon: CodeIcon,        color: "from-orange-500 to-yellow-400", textColor: "text-orange-400",  bgColor: "bg-orange-500/10" },
        file:  { label: t('tab.file'),  icon: FileText,        color: "from-indigo-500 to-blue-600",   textColor: "text-indigo-400",  bgColor: "bg-indigo-500/10" },
    };

    const hasDiscoveries = discoveries.links.length > 0 || discoveries.assets.length > 0 || discoveries.tasks.length > 0;

    const handleAction = (item: { value: string, action?: string }) => {
        if (item.action === 'open') {
            window.open(item.value, '_blank');
        } else {
            invoke("copy_to_clipboard", { content: item.value, kind: "text" });
        }
    };

    const handleModuleFilter = (key: string) => {
        onFilter(selectedRange.key, "time");
        if (key === "all") {
            onFilter("all", "type");
        } else {
            onFilter(key, "type");
        }
    };

    return (
        <div
            className="h-full overflow-y-auto p-6 space-y-8 custom-scrollbar animate-in slide-in-from-right duration-500 relative shadow-[-15px_0_40px_rgba(0,0,0,0.3)] z-40"
            style={{
                width: 'clamp(320px, 30vw, 480px)',
                overflow: 'auto',
                backgroundColor: 'var(--bg-color)',
                borderLeft: '1px solid var(--border-color)',
            }}
        >
            {/* Close */}
            <Tooltip text="返回主界面" position="left">
                <button
                    onClick={onClose}
                    className="absolute top-6 right-6 text-gray-400 hover:text-white transition-all z-50 p-1.5 hover:bg-white/10 rounded-full active:scale-90"
                >
                    <X size={18} />
                </button>
            </Tooltip>

            {/* Header */}
            <div className="relative">
                <div className="flex items-center gap-2 text-blue-400 font-bold mb-1">
                    <BarChart3 size={20} />
                    <span className="text-[12px] uppercase tracking-widest font-bold">Analyzer</span>
                </div>
                <h2 className="text-2xl font-bold text-[var(--text-main)] tracking-tight">分类筛选</h2>
                
                {/* Global Time Range */}
                <div className="grid grid-cols-3 gap-1.5 mt-4">
                    {RANGES.map((range) => (
                        <button
                            key={range.key}
                            onClick={() => {
                                setSelectedRange(range);
                                onFilter(range.key, "time");
                            }}
                            className={`py-2 text-[12px] font-bold rounded-xl transition-all ${
                                selectedRange.key === range.key
                                ? "bg-blue-600 text-white shadow-lg shadow-blue-500/20 scale-[1.03]"
                                : "bg-[var(--input-bg)] text-gray-500 hover:text-gray-300 border border-[var(--border-color)] hover:border-blue-500/30"
                            }`}
                        >
                            {t(range.i18nKey)}
                        </button>
                    ))}
                </div>
            </div>

            {loading ? (
                <div className="flex flex-col items-center justify-center py-24 space-y-4">
                    <div className="w-8 h-8 border-3 border-indigo-500/20 border-t-indigo-500 rounded-full animate-spin" />
                    <span className="text-[12px] text-gray-500 uppercase font-bold tracking-widest">{t('dash.loading')}</span>
                </div>
            ) : (
                <>
                    {/* Module Selectors: High Impact Grid */}
                    <div className="space-y-4">
                        <div className="flex items-center justify-between border-b border-white/5 pb-2">
                            <h3 className="text-[12px] font-bold text-[var(--text-main)] uppercase tracking-wider flex items-center gap-2">
                                <Clock size={14} className="text-blue-400" />
                                {t('dash.category_distribution_with_range', { range: t(selectedRange.i18nKey) })}
                            </h3>
                            <Tooltip text={t('dash.reset_tooltip')}>
                                <button onClick={() => onFilter("", "time_reset")} className="text-[12px] font-bold text-red-400/60 hover:text-red-400 transition-colors uppercase">{t('dash.reset')}</button>
                            </Tooltip>
                        </div>


                        {/* Stacked bar overview */}
                        {currentRangeTotal > 0 && (
                            <div className="space-y-3">
                                {/* Stacked horizontal bar */}
                                <div className="relative h-7 rounded-xl overflow-hidden bg-white/[0.04] flex">
                                    {Object.entries(typeConfig)
                                        .filter(([key]) => key !== 'all' && (stats[key] || 0) > 0)
                                        .sort((a, b) => (stats[b[0]] || 0) - (stats[a[0]] || 0))
                                        .map(([key, config], i) => {
                                            const count = stats[key] || 0;
                                            const pct = (count / currentRangeTotal) * 100;
                                            const color = config.textColor.includes('blue') ? '#3b82f6' :
                                                          config.textColor.includes('purple') ? '#a855f7' :
                                                          config.textColor.includes('emerald') ? '#22c55e' :
                                                          config.textColor.includes('orange') ? '#f97316' : '#6366f1';
                                            return (
                                                <div
                                                    key={key}
                                                    onClick={() => handleModuleFilter(key)}
                                                    className="h-full cursor-pointer transition-all duration-500 hover:brightness-125 relative group/seg app-bar-fill flex items-center justify-center overflow-hidden"
                                                    style={{
                                                        '--bar-width': `${pct}%`,
                                                        '--bar-delay': `${i * 100}ms`,
                                                        background: `linear-gradient(90deg, ${color}, ${color}cc)`,
                                                        minWidth: pct > 0 ? '4px' : '0',
                                                    } as React.CSSProperties}
                                                >
                                                    {/* Label inside bar on hover */}
                                                    <span className="text-[10px] font-bold text-white/0 group-hover/seg:text-white drop-shadow-md transition-colors duration-200 whitespace-nowrap px-1 truncate">
                                                        {config.label} {count}
                                                    </span>
                                                    {/* Tooltip above */}
                                                    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 rounded-lg bg-black/90 border border-white/10 text-[10px] text-white font-bold whitespace-nowrap opacity-0 group-hover/seg:opacity-100 transition-opacity pointer-events-none z-50">
                                                        {config.label} {count} ({Math.round(pct)}%)
                                                    </div>
                                                </div>
                                            );
                                        })}
                                </div>
                            </div>
                        )}

                        {/* Type bar list */}
                        {currentRangeTotal > 0 && (
                            <div className="space-y-1 dash-stagger">
                                {Object.entries(typeConfig)
                                    .filter(([key]) => key !== 'all' && (stats[key] || 0) > 0)
                                    .sort((a, b) => (stats[b[0]] || 0) - (stats[a[0]] || 0))
                                    .map(([key, config], i) => {
                                        const count = stats[key] || 0;
                                        const pct = Math.round((count / currentRangeTotal) * 100);
                                        const maxCount = Math.max(...Object.entries(typeConfig).filter(([k]) => k !== 'all').map(([k]) => stats[k] || 0));
                                        const barPct = Math.round((count / maxCount) * 100);
                                        const color = config.textColor.includes('blue') ? { main: '#60a5fa', glow: '#3b82f6' } :
                                                      config.textColor.includes('purple') ? { main: '#c084fc', glow: '#a855f7' } :
                                                      config.textColor.includes('emerald') ? { main: '#4ade80', glow: '#22c55e' } :
                                                      config.textColor.includes('orange') ? { main: '#fb923c', glow: '#f97316' } :
                                                      { main: '#818cf8', glow: '#6366f1' };
                                        const Icon = config.icon;
                                        return (
                                            <button key={key} onClick={() => handleModuleFilter(key)}
                                                className="w-full relative flex items-center gap-3 px-3 py-2 rounded-xl transition-all group hover:scale-[1.02] active:scale-[0.98] hover-glow"
                                                style={{ background: `${color.glow}12`, border: '1px solid transparent' }}
                                                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = `${color.glow}40`; }}
                                                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = 'transparent'; }}>
                                                <div className="absolute inset-0 rounded-xl overflow-hidden pointer-events-none">
                                                    <div className="h-full rounded-xl opacity-20 app-bar-fill"
                                                        style={{ '--bar-width': `${barPct}%`, '--bar-delay': `${i * 80}ms`, background: `linear-gradient(90deg, ${color.main}40, ${color.glow}10)` } as React.CSSProperties} />
                                                </div>
                                                <div className="w-5 h-5 rounded-md flex items-center justify-center shrink-0 relative z-10" style={{ background: `${color.glow}20` }}>
                                                    <Icon size={10} style={{ color: color.main }} />
                                                </div>
                                                <span className="text-[12px] font-medium truncate flex-1 text-left relative z-10" style={{ color: color.main }}>{config.label}</span>
                                                <span className="text-[12px] font-mono font-bold px-1.5 py-0.5 rounded relative z-10" style={{ color: color.main, background: `${color.glow}15` }}>{count}</span>
                                                <span className="text-[12px] font-mono relative z-10 w-7 text-right" style={{ color: `${color.main}80` }}>{pct}%</span>
                                            </button>
                                        );
                                    })}
                                {/* Total row — prominent */}
                                <button onClick={() => handleModuleFilter("all")}
                                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl bg-gradient-to-r from-blue-500/10 to-indigo-500/10 border border-blue-500/20 hover:border-blue-500/40 transition-all group hover:scale-[1.02] active:scale-[0.98]">
                                    <div className="w-5 h-5 rounded-md flex items-center justify-center shrink-0 bg-blue-500/20">
                                        <LayoutDashboard size={10} className="text-blue-400" />
                                    </div>
                                    <span className="text-[12px] font-bold text-gray-300 flex-1 text-left">{t('dash.total')}</span>
                                    <span className="text-base font-bold text-white count-pop">{currentRangeTotal}</span>
                                </button>
                            </div>
                        )}

                    </div>

                    {/* Source App Distribution — bar style */}
                    {sourceApps.length > 0 && (() => {
                        const COLORS = [
                            { main: "#22d3ee", glow: "#06b6d4" },
                            { main: "#60a5fa", glow: "#3b82f6" },
                            { main: "#c084fc", glow: "#a855f7" },
                            { main: "#4ade80", glow: "#22c55e" },
                            { main: "#fb923c", glow: "#f97316" },
                            { main: "#f472b6", glow: "#ec4899" },
                            { main: "#fbbf24", glow: "#f59e0b" },
                            { main: "#a78bfa", glow: "#8b5cf6" },
                        ];
                        const appTotal = sourceApps.reduce((a, b) => a + b[1], 0);

                        return (
                            <div className="space-y-4">
                                <div className="flex items-center justify-between border-b border-white/5 pb-2">
                                    <h3 className="text-[12px] font-bold text-[var(--text-main)] uppercase tracking-wider flex items-center gap-2">
                                        <Monitor size={14} className="text-cyan-400" />
                                        {t('dash.source_apps')}
                                    </h3>
                                    <span className="text-[12px] font-mono text-gray-500">{sourceApps.length} apps</span>
                                </div>

                                {/* Stacked bar overview */}
                                <div className="space-y-3">
                                    <div className="relative h-7 rounded-xl overflow-hidden bg-white/[0.04] flex">
                                        {sourceApps.slice(0, 8).map(([app, count], i) => {
                                            const pct = (count / appTotal) * 100;
                                            const c = COLORS[i % COLORS.length];
                                            return (
                                                <div key={app}
                                                    onClick={() => onFilter(app, "source_app")}
                                                    className="h-full cursor-pointer transition-all duration-500 hover:brightness-125 relative group/seg app-bar-fill flex items-center justify-center overflow-hidden"
                                                    style={{
                                                        '--bar-width': `${pct}%`,
                                                        '--bar-delay': `${i * 100}ms`,
                                                        background: `linear-gradient(90deg, ${c.main}, ${c.glow})`,
                                                        minWidth: pct > 0 ? '4px' : '0',
                                                    } as React.CSSProperties}
                                                >
                                                    <span className="text-[10px] font-bold text-white/0 group-hover/seg:text-white drop-shadow-md transition-colors duration-200 whitespace-nowrap px-1 truncate">
                                                        {app}
                                                    </span>
                                                    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 rounded-lg bg-black/90 border border-white/10 text-[10px] text-white font-bold whitespace-nowrap opacity-0 group-hover/seg:opacity-100 transition-opacity pointer-events-none z-50">
                                                        {app} {count} ({Math.round(pct)}%)
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>

                                <div className="space-y-1 dash-stagger">
                                    {sourceApps.slice(0, 8).map(([app, count], i) => {
                                        const maxCount = sourceApps[0]?.[1] || 1;
                                        const barPct = Math.round((count / maxCount) * 100);
                                        const pct = appTotal > 0 ? Math.round((count / appTotal) * 100) : 0;
                                        const c = COLORS[i % COLORS.length];
                                        return (
                                            <button key={app} onClick={() => onFilter(app, "source_app")}
                                                className="w-full relative flex items-center gap-3 px-3 py-2 rounded-xl transition-all group hover:scale-[1.02] active:scale-[0.98] hover-glow"
                                                style={{ background: `${c.glow}12`, border: '1px solid transparent' }}
                                                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = `${c.glow}40`; }}
                                                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = 'transparent'; }}>
                                                <div className="absolute inset-0 rounded-xl overflow-hidden pointer-events-none">
                                                    <div className="h-full rounded-xl opacity-20 app-bar-fill"
                                                        style={{ '--bar-width': `${barPct}%`, '--bar-delay': `${i * 80}ms`, background: `linear-gradient(90deg, ${c.main}40, ${c.glow}10)` } as React.CSSProperties} />
                                                </div>
                                                <div className="w-5 h-5 rounded-md flex items-center justify-center shrink-0 relative z-10" style={{ background: `${c.glow}20` }}>
                                                    <Globe size={10} style={{ color: c.main }} />
                                                </div>
                                                <span className="text-[12px] font-medium truncate flex-1 text-left relative z-10" style={{ color: c.main }}>{app}</span>
                                                <span className="text-[12px] font-mono font-bold px-1.5 py-0.5 rounded relative z-10" style={{ color: c.main, background: `${c.glow}15` }}>{count}</span>
                                                <span className="text-[12px] font-mono relative z-10 w-7 text-right" style={{ color: `${c.main}80` }}>{pct}%</span>
                                            </button>
                                        );
                                    })}
                                    {/* Total — prominent */}
                                    <div className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-gradient-to-r from-cyan-500/10 to-blue-500/10 border border-cyan-500/20">
                                        <div className="w-5 h-5 rounded-md flex items-center justify-center shrink-0 bg-cyan-500/20">
                                            <Monitor size={10} className="text-cyan-400" />
                                        </div>
                                        <span className="text-[12px] font-bold text-gray-300 flex-1 text-left">{t('dash.total')}</span>
                                        <span className="text-base font-bold text-white count-pop">{appTotal}</span>
                                    </div>
                                </div>
                            </div>
                        );
                    })()}

                    {/* Word Frequency — Bubble Chart */}
                    {Object.keys(wordStats).length > 0 && (() => {
                        const sorted = Object.entries(wordStats).sort((a, b) => b[1] - a[1]).slice(0, 15);
                        const maxC = sorted[0]?.[1] || 1;
                        const minC = sorted[sorted.length - 1]?.[1] || 0;
                        const BUBBLE_COLORS = [
                            "from-blue-500 to-cyan-400",
                            "from-violet-500 to-purple-400",
                            "from-emerald-500 to-teal-400",
                            "from-rose-500 to-pink-400",
                            "from-amber-500 to-yellow-400",
                            "from-sky-500 to-indigo-400",
                        ];

                        return (
                            <div className="space-y-4">
                                <div className="flex items-center gap-2 border-b border-white/5 pb-2 text-blue-400">
                                    <Hash size={16} />
                                    <h3 className="text-[12px] font-bold text-[var(--text-main)] uppercase tracking-wider">{t('dash.word_freq')}</h3>
                                </div>
                                <div className="flex flex-wrap items-center justify-center gap-2 py-2 min-h-[80px]">
                                    {sorted.map(([word, count], i) => {
                                        const weight = maxC === minC ? 0.5 : (count - minC) / (maxC - minC);
                                        const size = 56 + weight * 56; // 56px ~ 112px
                                        const colorClass = BUBBLE_COLORS[i % BUBBLE_COLORS.length];
                                        const opacity = 0.55 + weight * 0.45;

                                        return (
                                            <button
                                                key={word}
                                                onClick={() => onFilter(word)}
                                                className={`relative rounded-full bg-gradient-to-br ${colorClass} flex flex-col items-center justify-center
                                                    cursor-pointer transition-all duration-300
                                                    hover:scale-110 hover:shadow-lg active:scale-95 group bubble-float`}
                                                style={{
                                                    width: `${size}px`,
                                                    height: `${size}px`,
                                                    opacity,
                                                    animationDelay: `${i * 60}ms`,
                                                }}
                                                title={`${word}: ${count}`}
                                            >
                                                <span className="text-white font-bold drop-shadow-md leading-none text-center px-1 truncate max-w-full"
                                                    style={{ fontSize: `${Math.max(13, 13 + weight * 6)}px` }}>
                                                    {word}
                                                </span>
                                                <span className="text-white/90 font-mono font-bold leading-none mt-1 drop-shadow"
                                                    style={{ fontSize: `${Math.max(11, 10 + weight * 3)}px` }}>
                                                    {count}
                                                </span>
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        );
                    })()}

                    {/* Quick Search Tip */}
                    <div className="p-5 rounded-2xl bg-indigo-500/5 border border-indigo-500/10 space-y-2">
                        <div className="flex items-center gap-2 text-[12px] font-bold text-indigo-400 uppercase tracking-widest">
                            <Search size={12} />
                            {t('dash.filter_tip_title')}
                        </div>
                        <p className="text-[12px] text-gray-400 leading-relaxed">
                            {t('dash.filter_tip_body', { range: t(selectedRange.i18nKey) })}
                        </p>
                    </div>

                    {/* Smart Discoveries: Scaled down but present */}
                    {hasDiscoveries && (
                        <div className="space-y-3 pt-2">
                            <div className="flex items-center gap-2 border-b border-white/5 pb-2">
                                <Sparkles size={14} className="text-yellow-400" />
                                <h3 className="text-[12px] font-bold text-[var(--text-main)] uppercase tracking-wider">{t('dash.discovery')}</h3>
                            </div>
                            <div className="space-y-2">
                                {discoveries.tasks.concat(discoveries.links, discoveries.assets).slice(0, 3).map((item, i) => (
                                    <div key={`disc-${i}`} onClick={() => handleAction(item)} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--panel-bg)] border border-[var(--border-color)] hover:border-indigo-500/30 transition-all cursor-pointer truncate text-[12px] text-[var(--text-dim)] hover:text-[var(--text-main)]">
                                        <item.icon size={12} className="flex-shrink-0" />
                                        <span className="truncate">{item.value}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </>
            )}

            {/* Quick Actions */}
            <div className="grid grid-cols-2 gap-3 pt-4">
                    <button
                    onClick={onOpenSettings}
                    className="flex items-center justify-center gap-2 p-4 rounded-xl bg-[var(--input-bg)] border border-[var(--border-color)] text-[var(--text-dim)] hover:text-[var(--text-main)] hover:bg-[var(--panel-hover)] transition-all group"
                >
                    <Settings size={16} />
                    <span className="text-[12px] font-bold uppercase tracking-widest">设置</span>
                </button>
                <button
                    onClick={onClearHistory}
                    className="flex items-center justify-center gap-2 p-4 rounded-xl bg-[var(--input-bg)] border border-[var(--border-color)] text-[var(--text-dim)] hover:text-red-400 hover:bg-red-500/5 transition-all group"
                >
                    <Eraser size={16} />
                    <span className="text-[12px] font-bold uppercase tracking-widest">清空</span>
                </button>
            </div>
        </div>
    );
};

export default Dashboard;
