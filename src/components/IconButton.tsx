import type { ComponentType, MouseEvent } from "react";

export type IconButtonAccent = "indigo" | "emerald" | "amber" | "rose" | "red";

export interface IconButtonProps {
    icon: ComponentType<{ size?: number; className?: string }>;
    label: string;
    onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
    active?: boolean;
    disabled?: boolean;
    /** Hover / active tint. Default indigo. */
    accent?: IconButtonAccent;
    size?: number;
    /** Extra classes on the icon (e.g. `animate-spin` while loading). */
    iconClassName?: string;
}

/**
 * Tailwind needs string literals to keep classes in the JIT output, so
 * accent colours are hardcoded per variant rather than interpolated.
 */
const ACCENT: Record<IconButtonAccent, { active: string; hover: string }> = {
    // `disabled:hover:bg-black/50` cancels the accent hover colour when
    // the button is disabled so it doesn't flash the tint on mouse-over.
    indigo:  { active: "bg-indigo-500",  hover: "hover:bg-indigo-500 disabled:hover:bg-black/50"  },
    emerald: { active: "bg-emerald-500", hover: "hover:bg-emerald-500 disabled:hover:bg-black/50" },
    amber:   { active: "bg-amber-500",   hover: "hover:bg-amber-500 disabled:hover:bg-black/50"   },
    rose:    { active: "bg-rose-500",    hover: "hover:bg-rose-500 disabled:hover:bg-black/50"    },
    red:     { active: "bg-red-500",     hover: "hover:bg-red-500 disabled:hover:bg-black/50"     },
};

/**
 * Single definition for every top-right control on the image viewer.
 * Extend by adding an entry to the parent's `actions` config array —
 * no JSX-level churn needed.
 */
export function IconButton({
    icon: Icon,
    label,
    onClick,
    active = false,
    disabled = false,
    accent = "indigo",
    size = 16,
    iconClassName = "",
}: IconButtonProps) {
    const { active: activeBg, hover: hoverBg } = ACCENT[accent];
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            aria-label={label}
            title={label}
            className={[
                "p-1.5 rounded-lg backdrop-blur-md transition-all border border-white/10 text-white",
                active ? activeBg : `bg-black/50 ${hoverBg}`,
                disabled ? "opacity-30 cursor-not-allowed" : "",
            ].filter(Boolean).join(" ")}
        >
            <Icon size={size} className={iconClassName} />
        </button>
    );
}

export default IconButton;
