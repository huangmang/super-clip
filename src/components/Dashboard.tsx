import { useState, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/tauri";
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
    Hash
} from "lucide-react";
import Tooltip from "./Tooltip";

interface DashboardProps {
    onClose: () => void;
    onOpenSettings: () => void;
    onClearHistory: () => void;
    onFilter: (value: string, type?: string) => void;
    activeTab: string;
    timeFilter: string | null;
}

const RANGES = [
    { label: "30分钟", value: "-30 minutes", key: "30m" },
    { label: "2小时", value: "-2 hours", key: "2h" },
    { label: "3小时", value: "-3 hours", key: "3h" },
    { label: "一天", value: "-1 day", key: "1d" },
    { label: "三天", value: "-3 days", key: "3d" },
    { label: "一直", value: "all", key: "all" }
];

const Dashboard = ({ onClose, onOpenSettings, onClearHistory, onFilter, activeTab: _activeTab, timeFilter }: DashboardProps) => {
    const [selectedRange, setSelectedRange] = useState(RANGES[5]);
    const [stats, setStats] = useState<Record<string, number>>({});
    const [recentTexts, setRecentTexts] = useState<string[]>([]);
    const [loading, setLoading] = useState(true);

    // Sync selectedRange when timeFilter changes from outside (e.g. left sidebar)
    useEffect(() => {
        if (timeFilter === null) {
            setSelectedRange(RANGES[5]); // "一直"
        } else {
            const match = RANGES.find(r => r.key === timeFilter);
            if (match) setSelectedRange(match);
        }
    }, [timeFilter]);

    const wordStats = useMemo(() => {
        const segmenter = new (Intl as any).Segmenter('zh', { granularity: 'word' });
        const stats: Record<string, number> = {};
        const excluded = new Set(["的", "了", "和", "是", "在", "我", "有", "也", "就", "不", "这", "你", "他", "她", "它", "，", "。", "！", "？", "、", "：", "；", "“", "”", "‘", "’", "（", "）", "【", "】", "《", "》", "...", " ", "\n", "\t", "\r", "-", "_", "=", "+", "*", "/", "\\", "|", "&", "^", "%", "$", "#", "@", "!", "~", "`", "'", '"', "<", ">", ",", ".", "?", ";", ":", "[", "]", "{", "}", "(", ")", "一", "一个", "什么", "可以", "我们", "怎么", "这个", "那么", "这里", "那里", "如果"]);
        
        recentTexts.forEach(text => {
            const segments = segmenter.segment(text);
            for (const { segment, isWordLike } of segments) {
                const word = segment.trim();
                // Filter single letter, completely numeric words and short words
                if (isWordLike && word.length > 1 && !excluded.has(word) && !/^[0-9]+$/.test(word) && !/^[a-zA-Z]$/.test(word)) {
                    stats[word] = (stats[word] || 0) + 1;
                }
            }
        });
        return stats;
    }, [recentTexts]);

    const loadData = async (rangeValue: string) => {
        setLoading(true);
        try {
            const [statsData, textsData] = await Promise.all([
                invoke<Record<string, number>>("get_stats_by_range", { range: rangeValue }),
                invoke<string[]>("get_recent_content_by_range", { range: rangeValue })
            ]);
            setStats(statsData);
            setRecentTexts(textsData);
        } catch (error) {
            console.error("Failed to load dashboard data:", error);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadData(selectedRange.value);
    }, [selectedRange]);

    const currentRangeTotal = Object.values(stats).reduce((a, b) => a + b, 0);

    const typeConfig: Record<string, { label: string, icon: any, color: string, textColor: string, bgColor: string }> = {
        all: { label: "全部", icon: LayoutDashboard, color: "from-gray-500 to-gray-400", textColor: "text-gray-400", bgColor: "bg-white/5" },
        text: { label: "文本", icon: Type, color: "from-blue-500 to-cyan-400", textColor: "text-blue-400", bgColor: "bg-blue-500/10" },
        image: { label: "图片", icon: ImageIcon, color: "from-purple-500 to-pink-500", textColor: "text-purple-400", bgColor: "bg-purple-500/10" },
        link: { label: "链接", icon: LinkIcon, color: "from-emerald-500 to-teal-400", textColor: "text-emerald-400", bgColor: "bg-emerald-500/10" },
        code: { label: "代码", icon: CodeIcon, color: "from-orange-500 to-yellow-400", textColor: "text-orange-400", bgColor: "bg-orange-500/10" },
        file: { label: "文件", icon: FileText, color: "from-indigo-500 to-blue-600", textColor: "text-indigo-400", bgColor: "bg-indigo-500/10" },
    };


    // Smart Discovery Logic
    const discoveries = useMemo(() => {
        const results: Record<string, { value: string, icon: any, action?: string }[]> = {
            'links': [],
            'assets': [],
            'tasks': []
        };

        const patterns = {
            mail: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
            url: /https?:\/\/[^\s$.?#].[^\s]*/g,
            phone: /(?:\+?86)?\s?1[3-9]\d{9}/g,
            ip: /\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/g,
            task: /(?:TODO|FIXME|待办|任务|计划)[:：]\s*(.+)/gi
        };

        const seen = new Set();
        recentTexts.forEach(text => {
            const mails = text.match(patterns.mail);
            const urls = text.match(patterns.url);
            const phones = text.match(patterns.phone);

            mails?.forEach(m => { if (!seen.has(m)) { results.links.push({ value: m, icon: Mail }); seen.add(m); } });
            urls?.forEach(u => { if (!seen.has(u)) { results.links.push({ value: u, icon: Globe, action: 'open' }); seen.add(u); } });
            phones?.forEach(p => { if (!seen.has(p)) { results.links.push({ value: p, icon: Phone }); seen.add(p); } });

            const ips = text.match(patterns.ip);
            ips?.forEach(ip => { if (!seen.has(ip)) { results.assets.push({ value: ip, icon: Network }); seen.add(ip); } });

            let match;
            const taskRegex = new RegExp(patterns.task);
            while ((match = taskRegex.exec(text)) !== null) {
                const task = match[1].trim();
                if (!seen.has(task)) {
                    results.tasks.push({ value: task, icon: CheckCircle2 });
                    seen.add(task);
                }
            }
        });

        return results;
    }, [recentTexts]);

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

    // --- Radial Chart Logic (circle-based donut for seamless segments) ---
    const CHART_R = 160;
    const CHART_C = 2 * Math.PI * CHART_R; // circumference ≈ 1005.3

    const chartData = useMemo(() => {
        const entries = Object.entries(typeConfig)
            .filter(([key]) => key !== 'all')
            .map(([key, config]) => ({
                key,
                value: stats[key] || 0,
                color: config.textColor.includes('blue') ? '#58a6ff' : 
                       config.textColor.includes('purple') ? '#a78bfa' :
                       config.textColor.includes('emerald') ? '#34d399' :
                       config.textColor.includes('orange') ? '#fb923c' : '#818cf8',
                label: config.label
            }))
            .filter(d => d.value > 0);
        
        const total = entries.reduce((sum, d) => sum + d.value, 0);
        let consumed = 0;
        
        return entries.map(d => {
            const percentage = total > 0 ? d.value / total : 0;
            const segLen = percentage * CHART_C;
            // dashoffset positions the visible segment; offset = C*0.25 starts at 12 o'clock
            const offset = CHART_C * 0.25 - consumed;
            consumed += segLen;
            
            return {
                ...d,
                dashArray: `${segLen} ${CHART_C - segLen}`,
                dashOffset: offset,
                percentage: (percentage * 100).toFixed(0)
            };
        });
    }, [stats, currentRangeTotal]);

    return (
        <div 
            className="h-full overflow-y-auto p-6 space-y-8 custom-scrollbar animate-in slide-in-from-right duration-500 relative shadow-[-15px_0_40px_rgba(0,0,0,0.3)] z-40"
            style={{
                width: 'clamp(260px, 300px, 420px)',
                resize: 'horizontal',
                overflow: 'auto',
                backgroundColor: 'var(--bg-color)',
                borderLeft: '1px solid var(--border-color)',
                willChange: 'transform',
                transform: 'translateZ(0)',
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
                    <span className="text-[11px] uppercase tracking-widest font-black">Analyzer</span>
                </div>
                <h2 className="text-2xl font-black text-[var(--text-main)] tracking-tight">分类筛选</h2>
                
                {/* Global Time Range - Now more prominent as it controls the "Modules" */}
                <div className="flex bg-[var(--input-bg)] p-1 rounded-xl mt-4 border border-[var(--border-color)] shadow-inner">
                    {RANGES.map((range) => (
                        <button
                            key={range.key}
                            onClick={() => {
                                setSelectedRange(range);
                                onFilter(range.key, "time");
                            }}
                            className={`flex-1 py-1.5 text-[10px] font-black rounded-lg transition-all ${
                                selectedRange.key === range.key 
                                ? "bg-blue-600 text-white shadow-lg scale-105" 
                                : "text-gray-500 hover:text-gray-300"
                            }`}
                        >
                            {range.label}
                        </button>
                    ))}
                </div>
            </div>

            {loading ? (
                <div className="flex flex-col items-center justify-center py-24 space-y-4">
                    <div className="w-8 h-8 border-3 border-indigo-500/20 border-t-indigo-500 rounded-full animate-spin" />
                    <span className="text-[10px] text-gray-500 uppercase font-black tracking-widest">计算中...</span>
                </div>
            ) : (
                <>
                    {/* Module Selectors: High Impact Grid */}
                    <div className="space-y-4">
                        <div className="flex items-center justify-between border-b border-white/5 pb-2">
                            <h3 className="text-[11px] font-black text-[var(--text-main)] uppercase tracking-wider flex items-center gap-2">
                                <Clock size={14} className="text-blue-400" />
                                类别分布 ({selectedRange.label})
                            </h3>
                            <Tooltip text="重置所有筛选">
                                <button onClick={() => onFilter("", "time_reset")} className="text-[10px] font-bold text-red-400/60 hover:text-red-400 transition-colors uppercase">重置</button>
                            </Tooltip>
                        </div>


                        {/* Radial Analysis Visual */}
                        {currentRangeTotal > 0 && chartData.length > 0 && (
                            <div className="flex items-center justify-between bg-black/20 p-6 rounded-3xl border border-white/5 shadow-inner">
                                <div className="relative w-32 h-32 flex-shrink-0">
                                    <svg viewBox="0 0 400 400" className="w-full h-full" shapeRendering="geometricPrecision">
                                        {/* Background Track */}
                                        <circle cx="200" cy="200" r="160" fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="32" />
                                        
                                        {/* Segments - circle-based for seamless zero-gap rendering */}
                                        {chartData.map((d) => (
                                            <circle
                                                key={d.key}
                                                cx="200"
                                                cy="200"
                                                r="160"
                                                fill="none"
                                                stroke={d.color}
                                                strokeWidth="40"
                                                strokeDasharray={d.dashArray}
                                                strokeDashoffset={d.dashOffset}
                                                strokeLinecap="butt"
                                                onClick={() => handleModuleFilter(d.key)}
                                                className="transition-all duration-300 ease-out cursor-pointer hover:stroke-[48px]"
                                            />
                                        ))}
                                    </svg>
                                    <div 
                                        className="absolute inset-0 flex flex-col items-center justify-center cursor-pointer group/total"
                                        onClick={() => handleModuleFilter("all")}
                                    >
                                        <span className="text-2xl font-black text-white leading-none group-hover/total:text-blue-400 transition-colors">{currentRangeTotal}</span>
                                        <span className="text-[10px] text-gray-500 uppercase font-black tracking-widest mt-1 group-hover/total:text-blue-400/50 transition-colors">总计</span>
                                    </div>
                                </div>
                                
                                <div className="flex flex-col gap-2.5 flex-1 pl-6">
                                    {chartData.slice(0, 5).map(d => (
                                        <div 
                                            key={d.key} 
                                            onClick={() => handleModuleFilter(d.key)}
                                            className="flex items-center justify-between cursor-pointer group/item hover:translate-x-1 transition-transform"
                                        >
                                            <div className="flex items-center gap-2">
                                                <div className="w-2 h-2 rounded-full transition-transform group-hover/item:scale-150" style={{ backgroundColor: d.color }} />
                                                <span className="text-[10px] font-bold text-gray-400 group-hover/item:text-white transition-colors">{d.label}</span>
                                            </div>
                                            <span className="text-[10px] font-black text-white opacity-40 group-hover/item:opacity-100 transition-opacity">{d.percentage}%</span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                        
                    </div>

                    {/* Word Frequency Stats - Native Calculation */}
                    {Object.keys(wordStats).length > 0 && (
                        <div className="space-y-4">
                            <div className="flex items-center gap-2 border-b border-white/5 pb-2 text-blue-400">
                                <Hash size={16} />
                                <h3 className="text-[11px] font-black text-[var(--text-main)] uppercase tracking-wider">高频词统计</h3>
                            </div>
                            <div className="flex flex-wrap items-center gap-2 py-1">
                                {Object.entries(wordStats)
                                    .sort((a, b) => b[1] - a[1])
                                    .slice(0, 20)
                                    .map(([tag, count]) => {
                                        const counts = Object.values(wordStats);
                                        const maxCount = Math.max(...counts);
                                        const minCount = Math.min(...counts);
                                        const weight = maxCount === minCount ? 1 : (count - minCount) / (maxCount - minCount);
                                        
                                        return (
                                            <div
                                                key={tag}
                                                onClick={() => onFilter(tag)}
                                                className="group px-3 py-1.5 rounded-full bg-blue-500/5 border border-blue-500/10 hover:border-blue-400/50 hover:bg-blue-500/10 transition-all cursor-pointer active:scale-95 flex items-center gap-2"
                                            >
                                                <span className={`font-bold transition-colors ${weight > 0.7 ? 'text-blue-300' : 'text-gray-400 group-hover:text-blue-300'}`} style={{ fontSize: `${10 + weight * 4}px` }}>
                                                    {tag}
                                                </span>
                                                <span className="text-[9px] text-gray-600 font-black px-1.5 py-0.5 rounded-md bg-white/5 group-hover:bg-blue-500/20 group-hover:text-blue-300 transition-all">{count}</span>
                                            </div>
                                        );
                                    })}
                            </div>
                        </div>
                    )}

                    {/* Quick Search Tip */}
                    <div className="p-5 rounded-2xl bg-indigo-500/5 border border-indigo-500/10 space-y-2">
                        <div className="flex items-center gap-2 text-[10px] font-black text-indigo-400 uppercase tracking-widest">
                            <Search size={12} />
                            筛选说明
                        </div>
                        <p className="text-[11px] text-gray-400 leading-relaxed">
                            点击上方模块将同时应用 <span className="text-white font-bold">{selectedRange.label}</span> 与 <span className="text-white font-bold">分类类型</span> 过滤，主列表将即时更新。
                        </p>
                    </div>

                    {/* Smart Discoveries: Scaled down but present */}
                    {hasDiscoveries && (
                        <div className="space-y-3 pt-2">
                            <div className="flex items-center gap-2 border-b border-white/5 pb-2">
                                <Sparkles size={14} className="text-yellow-400" />
                                <h3 className="text-[11px] font-black text-[var(--text-main)] uppercase tracking-wider">智能发现</h3>
                            </div>
                            <div className="space-y-2">
                                {discoveries.tasks.concat(discoveries.links, discoveries.assets).slice(0, 3).map((item, i) => (
                                    <div key={`disc-${i}`} onClick={() => handleAction(item)} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--panel-bg)] border border-[var(--border-color)] hover:border-indigo-500/30 transition-all cursor-pointer truncate text-[11px] text-[var(--text-dim)] hover:text-[var(--text-main)]">
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
                    <span className="text-[10px] font-black uppercase tracking-widest">设置</span>
                </button>
                <button
                    onClick={onClearHistory}
                    className="flex items-center justify-center gap-2 p-4 rounded-xl bg-[var(--input-bg)] border border-[var(--border-color)] text-[var(--text-dim)] hover:text-red-400 hover:bg-red-500/5 transition-all group"
                >
                    <Eraser size={16} />
                    <span className="text-[10px] font-black uppercase tracking-widest">清空</span>
                </button>
            </div>
        </div>
    );
};

export default Dashboard;
