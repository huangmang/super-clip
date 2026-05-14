import type { ReactNode, CSSProperties } from "react";

/**
 * Single source of truth for the "dark glass" visual language shared by
 * every OCR-viewer overlay (tooltip, toast, hint, pill, context menu,
 * search bar, loading indicator). Import these directly when an inline
 * style needs to match a GlassSurface pixel-for-pixel — e.g. the caret
 * on the hover tooltip, whose background colour must match the card's
 * bottom-gradient stop.
 *
 * Changing a brand/theme value here propagates everywhere; don't inline
 * these colours in callsites.
 */
export const GLASS_TOKENS = {
    bgCard: "linear-gradient(180deg, rgba(30,30,34,0.92) 0%, rgba(18,18,22,0.92) 100%)",
    bgPill: "linear-gradient(180deg, rgba(30,30,34,0.95) 0%, rgba(18,18,22,0.95) 100%)",
    edgeTopSolid: "rgba(30,30,34,0.92)",
    edgeBottomSolid: "rgba(18,18,22,0.92)",
    blur: "blur(20px) saturate(1.6)",
    hairline: "0 0 0 1px rgba(255,255,255,0.08)",
    topHighlight: "0 1px 0 0 rgba(255,255,255,0.07) inset",
    shadowCard: "0 10px 30px -8px rgba(0,0,0,0.55), 0 4px 8px -2px rgba(0,0,0,0.35)",
    shadowPill: "0 12px 36px -10px rgba(0,0,0,0.6), 0 4px 10px -2px rgba(0,0,0,0.3)",
    accentIndigo: "linear-gradient(90deg, transparent 0%, rgba(129,140,248,0.55) 50%, transparent 100%)",
    accentEmerald: "linear-gradient(90deg, transparent 0%, rgba(52,211,153,0.55) 50%, transparent 100%)",
    accentAmber: "linear-gradient(90deg, transparent 0%, rgba(251,191,36,0.55) 50%, transparent 100%)",
    radiusCard: 12,
    radiusPill: 9999,
    // Consistent fade-zoom enter class; pair with `slide-in-from-*-1`
    // at callsite when direction matters.
    enterAnimClass: "animate-in fade-in zoom-in-95 duration-200 ease-out",
} as const;

type Variant = "card" | "pill";
type Accent = "indigo" | "emerald" | "amber" | null;

interface GlassSurfaceProps {
    variant?: Variant;
    /** Optional 1.5px gradient stripe at the top edge. */
    accent?: Accent;
    className?: string;
    style?: CSSProperties;
    children?: ReactNode;
    /** If true, applies the shared enter animation class. */
    animate?: boolean;
}

/**
 * Dark-glass overlay primitive. Exactly two variants:
 *   - 'card' → 12px radius, card shadow. Tooltips, context menus.
 *   - 'pill' → fully rounded, pill shadow. Toasts, status hints.
 *
 * Visual concern only — behaviour (dismiss, positioning, focus trap)
 * stays at the callsite. Keep this dumb.
 */
export function GlassSurface({
    variant = "card",
    accent = null,
    className = "",
    style,
    children,
    animate = false,
}: GlassSurfaceProps) {
    const isPill = variant === "pill";
    const accentBg =
        accent === "indigo" ? GLASS_TOKENS.accentIndigo :
        accent === "emerald" ? GLASS_TOKENS.accentEmerald :
        accent === "amber" ? GLASS_TOKENS.accentAmber : null;

    return (
        <div
            className={[
                "relative overflow-hidden",
                animate ? GLASS_TOKENS.enterAnimClass : "",
                className,
            ].filter(Boolean).join(" ")}
            style={{
                background: isPill ? GLASS_TOKENS.bgPill : GLASS_TOKENS.bgCard,
                backdropFilter: GLASS_TOKENS.blur,
                WebkitBackdropFilter: GLASS_TOKENS.blur,
                boxShadow: [
                    GLASS_TOKENS.topHighlight,
                    GLASS_TOKENS.hairline,
                    isPill ? GLASS_TOKENS.shadowPill : GLASS_TOKENS.shadowCard,
                ].join(", "),
                borderRadius: isPill ? GLASS_TOKENS.radiusPill : GLASS_TOKENS.radiusCard,
                ...style,
            }}
        >
            {accentBg && (
                <div
                    className="absolute inset-x-0 top-0 h-[1.5px] pointer-events-none"
                    style={{ background: accentBg }}
                />
            )}
            {children}
        </div>
    );
}

export default GlassSurface;
