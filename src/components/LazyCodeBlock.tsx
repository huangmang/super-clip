import { useEffect, useState } from "react";

// Lazy-loaded code highlighter. Splits ~200KB of `react-syntax-highlighter`
// + Prism themes out of the initial bundle so the main window paints faster
// — they're only fetched when the user actually has a code clip to render.

interface Props {
    language: string;
    code: string;
    theme: "dark" | "light";
}

type LoadedModules = {
    Highlighter: any;
    style: any;
};

let cachedDark: LoadedModules | null = null;
let cachedLight: LoadedModules | null = null;

async function loadHighlighter(theme: "dark" | "light"): Promise<LoadedModules> {
    if (theme === "dark" && cachedDark) return cachedDark;
    if (theme === "light" && cachedLight) return cachedLight;

    const [shMod, styleMod] = await Promise.all([
        import("react-syntax-highlighter"),
        import("react-syntax-highlighter/dist/esm/styles/prism"),
    ]);
    const loaded: LoadedModules = {
        Highlighter: shMod.Prism,
        style: theme === "dark" ? styleMod.atomDark : styleMod.prism,
    };
    if (theme === "dark") cachedDark = loaded;
    else cachedLight = loaded;
    return loaded;
}

const LazyCodeBlock: React.FC<Props> = ({ language, code, theme }) => {
    const [mods, setMods] = useState<LoadedModules | null>(
        theme === "dark" ? cachedDark : cachedLight
    );

    useEffect(() => {
        let alive = true;
        loadHighlighter(theme).then(m => {
            if (alive) setMods(m);
        });
        return () => {
            alive = false;
        };
    }, [theme]);

    if (!mods) {
        // Tiny inline fallback while the chunk loads. Stays consistent with
        // the eventual SyntaxHighlighter wrapper styles so layout doesn't jump.
        return (
            <pre
                style={{
                    margin: 0,
                    padding: "16px 12px",
                    fontSize: "12px",
                    lineHeight: "1.6",
                    background: "transparent",
                    fontFamily: '"Fira Code", "Cascadia Code", "JetBrains Mono", monospace',
                    color: "var(--text-dim)",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                }}
            >
                {code}
            </pre>
        );
    }

    const { Highlighter, style } = mods;
    return (
        <Highlighter
            language={language}
            style={style}
            showLineNumbers
            lineNumberStyle={{
                minWidth: "2.5em",
                paddingRight: "1em",
                color: "var(--text-dim)",
                textAlign: "right",
                fontSize: "11px",
                userSelect: "none",
            }}
            customStyle={{
                margin: 0,
                padding: "16px 12px",
                fontSize: "12px",
                lineHeight: "1.6",
                background: "transparent",
                fontFamily: '"Fira Code", "Cascadia Code", "JetBrains Mono", monospace',
            }}
        >
            {code}
        </Highlighter>
    );
};

export default LazyCodeBlock;
