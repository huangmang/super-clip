import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig(async () => ({
    plugins: [react()],

    // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
    //
    // 1. prevent vite from obscuring rust errors
    clearScreen: false,
    // 2. tauri expects a fixed port, fail if that port is not available
    server: {
        port: 5173,
        strictPort: true,
        host: true,
        watch: {
            // 3. tell vite to ignore watching `src-tauri`
            ignored: ["**/src-tauri/**"],
        },
    },

    build: {
        // Even though Tauri ships the bundle locally (so byte-for-byte size
        // matters less than for a web app), splitting vendor chunks still
        // pays off: WebView2 parses each chunk independently and can keep
        // them in its disk cache across reloads. Pre-fix the main chunk
        // was ~1.6MB and triggered Vite's 500KB warning; this brings it
        // down meaningfully and improves cold-start TTI.
        rollupOptions: {
            output: {
                manualChunks: {
                    "react-vendor": ["react", "react-dom"],
                    "icon-vendor": ["lucide-react"],
                    "sanitize-vendor": ["dompurify"],
                    "tauri-api": ["@tauri-apps/api"],
                },
            },
        },
        // Quiet the warning — we've actively split. Keeping a sane default
        // ceiling so a future regression still gets flagged.
        chunkSizeWarningLimit: 800,
    },
}));
