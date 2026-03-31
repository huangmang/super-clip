import React, { useState, useRef, useEffect } from "react";

interface TooltipProps {
    text: string;
    children: React.ReactNode;
    delay?: number;
    position?: "top" | "bottom" | "left" | "right";
    offset?: number;
}

const Tooltip = ({ text, children, delay = 150, position = "top", offset }: TooltipProps) => {
    const [isVisible, setIsVisible] = useState(false);
    const timeoutRef = useRef<any>(null);

    const showTooltip = () => {
        timeoutRef.current = setTimeout(() => {
            setIsVisible(true);
        }, delay);
    };

    const hideTooltip = () => {
        if (timeoutRef.current) {
            clearTimeout(timeoutRef.current);
        }
        setIsVisible(false);
    };

    useEffect(() => {
        return () => {
            if (timeoutRef.current) clearTimeout(timeoutRef.current);
        };
    }, []);

    const positionClasses = {
        top: "bottom-full left-1/2 -translate-x-1/2",
        bottom: "top-full left-1/2 -translate-x-1/2",
        left: "right-full top-1/2 -translate-y-1/2",
        right: "left-full top-1/2 -translate-y-1/2",
    };

    const getOffsetStyle = () => {
        if (offset === undefined) return {
            marginTop: position === "bottom" ? "12px" : undefined,
            marginBottom: position === "top" ? "12px" : undefined,
            marginLeft: position === "right" ? "12px" : undefined,
            marginRight: position === "left" ? "12px" : undefined,
        };
        return {
            marginTop: position === "bottom" ? `${offset}px` : undefined,
            marginBottom: position === "top" ? `${offset}px` : undefined,
            marginLeft: position === "right" ? `${offset}px` : undefined,
            marginRight: position === "left" ? `${offset}px` : undefined,
        };
    };

    const arrowClasses = {
        top: "top-full left-1/2 -translate-x-1/2 border-t-white/20 border-x-transparent border-b-transparent",
        bottom: "bottom-full left-1/2 -translate-x-1/2 border-b-white/20 border-x-transparent border-t-transparent",
        left: "left-full top-1/2 -translate-y-1/2 border-l-white/20 border-y-transparent border-r-transparent",
        right: "right-full top-1/2 -translate-y-1/2 border-r-white/20 border-y-transparent border-l-transparent",
    };

    return (
        <div
            className="relative flex items-center group/tooltip"
            onMouseEnter={showTooltip}
            onMouseLeave={hideTooltip}
        >
            {children}
            {isVisible && (
                <div
                    className={`absolute z-[100] px-2 py-1 bg-[#1a1a1a]/95 backdrop-blur-md border border-white/10 text-indigo-50 text-[10px] font-medium rounded-md shadow-2xl whitespace-nowrap pointer-events-none animate-in fade-in zoom-in-95 slide-in-from-bottom-1 duration-200 ease-out ${positionClasses[position]}`}
                    style={getOffsetStyle()}
                >
                    <span className="relative z-10 flex items-center gap-1">
                        <span className="w-1 h-1 rounded-full bg-indigo-400/80" />
                        {text}
                    </span>
                    {(!offset || offset <= 20) && (
                        <div className={`absolute border-[4px] opacity-50 ${arrowClasses[position]}`} />
                    )}
                </div>
            )}
        </div>
    );
};

export default Tooltip;
