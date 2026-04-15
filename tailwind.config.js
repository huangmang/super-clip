/** @type {import('tailwindcss').Config} */
export default {
    content: [
        "./index.html",
        "./src/**/*.{js,ts,jsx,tsx}",
    ],
    theme: {
        extend: {
            animation: {
                'shimmer': 'shimmer 2s ease-in-out infinite',
                'glow-pulse': 'glow-pulse 2s ease-in-out infinite',
                'slide-up': 'slide-up 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
                'slide-down': 'slide-down 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
                'scale-in': 'scale-in 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
                'bar-fill': 'bar-fill 0.8s cubic-bezier(0.16, 1, 0.3, 1) forwards',
                'fade-up': 'fade-up 0.5s cubic-bezier(0.16, 1, 0.3, 1) forwards',
                'counter': 'counter 0.6s cubic-bezier(0.16, 1, 0.3, 1)',
                'ring-draw': 'ring-draw 1.2s cubic-bezier(0.65, 0, 0.35, 1) forwards',
                'float': 'float 6s ease-in-out infinite',
            },
            keyframes: {
                'shimmer': {
                    '0%': { backgroundPosition: '-200% 0' },
                    '100%': { backgroundPosition: '200% 0' },
                },
                'glow-pulse': {
                    '0%, 100%': { boxShadow: '0 0 8px rgba(99, 102, 241, 0.3), inset 0 0 8px rgba(99, 102, 241, 0.1)' },
                    '50%': { boxShadow: '0 0 20px rgba(99, 102, 241, 0.5), inset 0 0 12px rgba(99, 102, 241, 0.2)' },
                },
                'slide-up': {
                    '0%': { opacity: '0', transform: 'translateY(12px)' },
                    '100%': { opacity: '1', transform: 'translateY(0)' },
                },
                'slide-down': {
                    '0%': { opacity: '0', transform: 'translateY(-12px)' },
                    '100%': { opacity: '1', transform: 'translateY(0)' },
                },
                'scale-in': {
                    '0%': { opacity: '0', transform: 'scale(0.9)' },
                    '100%': { opacity: '1', transform: 'scale(1)' },
                },
                'bar-fill': {
                    '0%': { width: '0%' },
                    '100%': { width: 'var(--bar-width)' },
                },
                'fade-up': {
                    '0%': { opacity: '0', transform: 'translateY(8px)' },
                    '100%': { opacity: '1', transform: 'translateY(0)' },
                },
                'counter': {
                    '0%': { opacity: '0', transform: 'scale(0.5)' },
                    '60%': { transform: 'scale(1.15)' },
                    '100%': { opacity: '1', transform: 'scale(1)' },
                },
                'ring-draw': {
                    '0%': { strokeDashoffset: 'var(--ring-circumference)' },
                    '100%': { strokeDashoffset: 'var(--ring-target)' },
                },
                'float': {
                    '0%, 100%': { transform: 'translateY(0px)' },
                    '50%': { transform: 'translateY(-4px)' },
                },
            },
        },
    },
    plugins: [],
}
