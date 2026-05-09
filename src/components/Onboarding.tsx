import { useState } from "react";
import { Keyboard, MousePointerClick, Search, Sparkles, X, ChevronRight, Check } from "lucide-react";
import { t } from "../i18n";

interface OnboardingProps {
    onClose: () => void;
}

const STORAGE_KEY = "super-clip:onboarding-seen-v1";

export const shouldShowOnboarding = (): boolean => {
    try {
        return localStorage.getItem(STORAGE_KEY) !== "true";
    } catch {
        return false;
    }
};

export const markOnboardingSeen = (): void => {
    try {
        localStorage.setItem(STORAGE_KEY, "true");
    } catch {
        /* noop — private mode etc. */
    }
};

const Onboarding: React.FC<OnboardingProps> = ({ onClose }) => {
    const [step, setStep] = useState(0);

    const steps = [
        {
            icon: Sparkles,
            color: "text-indigo-400",
            bg: "from-indigo-500/20 to-purple-500/10",
            title: t('onboard.s1_title'),
            body: t('onboard.s1_body'),
            kbd: null as null | string[],
        },
        {
            icon: Keyboard,
            color: "text-blue-400",
            bg: "from-blue-500/20 to-cyan-500/10",
            title: t('onboard.s2_title'),
            body: t('onboard.s2_body'),
            kbd: ["Ctrl", "+", "Space"],
        },
        {
            icon: Search,
            color: "text-emerald-400",
            bg: "from-emerald-500/20 to-teal-500/10",
            title: t('onboard.s3_title'),
            body: t('onboard.s3_body'),
            kbd: ["Ctrl", "+", "M"],
        },
        {
            icon: MousePointerClick,
            color: "text-amber-400",
            bg: "from-amber-500/20 to-orange-500/10",
            title: t('onboard.s4_title'),
            body: t('onboard.s4_body'),
            kbd: null,
        },
    ];

    const isLast = step === steps.length - 1;
    const current = steps[step];
    const Icon = current.icon;

    const finish = () => {
        markOnboardingSeen();
        onClose();
    };

    return (
        <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="onboarding-title"
            className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60 backdrop-blur-md p-4 animate-in fade-in duration-200"
        >
            <div className="bg-[var(--panel-bg)] w-full max-w-md rounded-2xl border border-[var(--border-color)] shadow-2xl p-7 space-y-5 animate-in zoom-in-95 duration-200 relative">
                <button
                    onClick={finish}
                    aria-label={t('onboard.skip')}
                    className="absolute top-4 right-4 text-[var(--text-dim)] hover:text-[var(--text-main)] p-1.5 rounded-lg hover:bg-white/5 transition-colors"
                >
                    <X size={16} />
                </button>

                <div className={`w-14 h-14 rounded-2xl flex items-center justify-center bg-gradient-to-br ${current.bg}`}>
                    <Icon size={26} className={current.color} />
                </div>

                <div className="space-y-2">
                    <h3 id="onboarding-title" className="text-lg font-bold text-[var(--text-main)]">
                        {current.title}
                    </h3>
                    <p className="text-sm text-[var(--text-dim)] leading-relaxed">
                        {current.body}
                    </p>
                </div>

                {current.kbd && (
                    <div className="flex items-center gap-1.5">
                        {current.kbd.map((k, i) =>
                            k === "+" ? (
                                <span key={i} className="text-[var(--text-dim)] text-xs">+</span>
                            ) : (
                                <kbd
                                    key={i}
                                    className="px-2.5 py-1 rounded-md bg-white/5 border border-white/10 text-[var(--text-main)] font-mono text-[12px] font-bold shadow-sm"
                                >
                                    {k}
                                </kbd>
                            )
                        )}
                    </div>
                )}

                {/* Step dots */}
                <div className="flex items-center justify-between pt-3 border-t border-white/5">
                    <div className="flex items-center gap-1.5">
                        {steps.map((_, i) => (
                            <div
                                key={i}
                                className={`h-1.5 rounded-full transition-all ${
                                    i === step ? "w-6 bg-indigo-400" : "w-1.5 bg-white/15"
                                }`}
                            />
                        ))}
                    </div>

                    <div className="flex items-center gap-2">
                        <button
                            onClick={finish}
                            className="text-[12px] text-[var(--text-dim)] hover:text-[var(--text-main)] px-2 py-1 rounded-md transition-colors"
                        >
                            {t('onboard.skip')}
                        </button>
                        <button
                            onClick={() => isLast ? finish() : setStep(step + 1)}
                            className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-[12px] font-bold bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-500/20 transition-all"
                        >
                            {isLast ? <><Check size={12} /> {t('onboard.done')}</> : <>{t('onboard.next')} <ChevronRight size={12} /></>}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default Onboarding;
