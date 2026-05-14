import type { OcrLine } from "../components/OCRLayer";

// ── helpers ───────────────────────────────────────────────────────────
const bboxY = (line: OcrLine) => {
    const c = line.box_coords!;
    const minY = Math.min(...c.map(p => p[1]));
    const maxY = Math.max(...c.map(p => p[1]));
    return { minY, maxY, h: maxY - minY };
};
const bboxX = (line: OcrLine) => {
    const c = line.box_coords!;
    const minX = Math.min(...c.map(p => p[0]));
    const maxX = Math.max(...c.map(p => p[0]));
    return { minX, maxX, w: maxX - minX };
};

const isCjk = (ch: string): boolean => {
    const c = ch.charCodeAt(0);
    return (
        (c >= 0x3000 && c <= 0x303F) ||   // CJK symbols & punctuation
        (c >= 0x4E00 && c <= 0x9FFF) ||   // CJK Unified Ideographs
        (c >= 0xFF00 && c <= 0xFFEF) ||   // Halfwidth/Fullwidth
        (c >= 0x3040 && c <= 0x30FF)      // Hiragana/Katakana
    );
};

const sortSpatially = (lines: OcrLine[]): OcrLine[] =>
    [...lines].filter(l => l.box_coords && l.box_coords.length >= 2).sort((a, b) => {
        const aY = bboxY(a).minY;
        const bY = bboxY(b).minY;
        if (Math.abs(aY - bY) > 10) return aY - bY;
        return bboxX(a).minX - bboxX(b).minX;
    });

// ── paragraph reconstruction ──────────────────────────────────────────
// Join lines that visually belong to the same paragraph; insert blank line
// between paragraphs. Paragraph break heuristic: big vertical gap (> 0.8 ×
// line height) OR the left margin jumps by more than 1.5 × line height.
export const reconstructParagraphs = (lines: OcrLine[]): string => {
    const sorted = sortSpatially(lines);
    if (sorted.length === 0) return "";

    const heights = sorted.map(l => bboxY(l).h).filter(h => h > 0);
    const avgH = heights.length > 0 ? heights.reduce((a, b) => a + b, 0) / heights.length : 20;

    let out = sorted[0].text;
    for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1];
        const cur = sorted[i];
        const vGap = bboxY(cur).minY - bboxY(prev).maxY;
        const leftDiff = Math.abs(bboxX(cur).minX - bboxX(prev).minX);

        if (vGap > avgH * 0.8 || leftDiff > avgH * 1.5) {
            out += "\n\n" + cur.text;
        } else {
            // CJK has no inter-word space; mixed / Latin joins with a single space
            const prevLast = prev.text.slice(-1);
            const curFirst = cur.text.slice(0, 1);
            const sep = isCjk(prevLast) || isCjk(curFirst) ? "" : " ";
            out += sep + cur.text;
        }
    }
    return out;
};

// ── table detection ───────────────────────────────────────────────────
// Returns rows of cell strings if the layout looks tabular, else null.
// Criteria: ≥3 rows, each row has the same column count (tolerance 1),
// each row has ≥2 columns.
export const detectTable = (lines: OcrLine[]): string[][] | null => {
    if (lines.length < 6) return null;
    const sorted = sortSpatially(lines);

    const heights = sorted.map(l => bboxY(l).h).filter(h => h > 0);
    if (heights.length === 0) return null;
    const avgH = heights.reduce((a, b) => a + b, 0) / heights.length;
    const rowTol = avgH * 0.6;

    // Cluster into rows by Y
    const rows: OcrLine[][] = [];
    for (const line of sorted) {
        const y = bboxY(line).minY;
        const bucket = rows.find(r => Math.abs(bboxY(r[0]).minY - y) <= rowTol);
        if (bucket) bucket.push(line);
        else rows.push([line]);
    }

    if (rows.length < 3) return null;
    const multiCol = rows.filter(r => r.length >= 2);
    if (multiCol.length < 3) return null;

    const counts = multiCol.map(r => r.length);
    const maxC = Math.max(...counts);
    const minC = Math.min(...counts);
    if (maxC - minC > 1) return null;

    return rows.map(r =>
        [...r]
            .sort((a, b) => bboxX(a).minX - bboxX(b).minX)
            .map(l => l.text)
    );
};

export const tableToTsv = (rows: string[][]): string =>
    rows.map(r => r.join("\t")).join("\n");

// ── smart link detection ──────────────────────────────────────────────
// The previous implementation used a single permissive phone regex that
// fired on any 7-15 digit run with separators. In practice that swept up
// dates ("2026-05-14"), version numbers ("1.2.3.456"), order IDs, IP
// addresses, and the like. The rewrite below uses *country-specific*
// patterns anchored to non-digit boundaries (lookbehind/ahead) plus a
// post-filter rejecting monotonic / repeated digits, then validates
// emails for shape (TLD length, no consecutive dots, leading char).
export type SmartLink = { type: "url" | "email" | "phone"; value: string };

const URL_RE = /https?:\/\/[^\s<>"']+/gi;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}/g;

// Phone patterns ordered most-specific → most-general so the first match
// wins per region. `(?<![\d.\-])` / `(?![\d.\-])` keep matches from
// landing inside a longer digit/dot/hyphen run (defeats version numbers
// and IP-like strings). Lookbehind / lookahead are ES2018; WebView2 is
// modern Chromium so support is universal here.
const PHONE_PATTERNS: RegExp[] = [
    // CN mobile (most common): 1[3-9]xxxxxxxxx (11 digits, no separators)
    /(?<![\d.\-])1[3-9]\d{9}(?![\d.\-])/g,
    // CN service: 400/800 + 7-8 digits, optional separators
    /(?<![\d.\-])(?:400|800)[-\s]?\d{3,4}[-\s]?\d{3,4}(?![\d.\-])/g,
    // CN landline w/ area code: (0xx)yyyy-yyyy / 0xx-yyyy-yyyy
    /(?<![\d.\-])\(?0\d{2,3}\)?[-\s]\d{4}[-\s]?\d{4}(?![\d.\-])/g,
    // International (+CC): +xx[-\s]xxxx-xxxx (CC 1-3 digits, total 8-15)
    /(?<![\d.\-])\+\d{1,3}[-\s]?\d{2,4}[-\s]?\d{3,4}[-\s]?\d{3,4}(?![\d.\-])/g,
    // NA/US format with mandatory separator: NNN-NNN-NNNN, (NNN) NNN-NNNN
    /(?<![\d.\-])\(?\d{3}\)?[-\s]\d{3}[-\s]?\d{4}(?![\d.\-])/g,
];

const isMonotonicOrRepeated = (s: string): boolean => {
    const digits = s.replace(/\D/g, "");
    if (digits.length < 7) return true;                 // too short = noise
    if (/^(\d)\1+$/.test(digits)) return true;          // all same digit
    let inc = true, dec = true;
    for (let i = 1; i < digits.length; i++) {
        const d = digits.charCodeAt(i) - digits.charCodeAt(i - 1);
        if (d !== 1) inc = false;
        if (d !== -1) dec = false;
    }
    return inc || dec;                                  // 12345678 / 98765432
};

const isValidEmail = (s: string): boolean => {
    if (!/^[A-Za-z0-9_+-]/.test(s)) return false;       // local must start with alnum/_/+/-
    if (/\.\./.test(s)) return false;                   // no consecutive dots
    if (s.length > 254) return false;                   // RFC 5321 cap
    const at = s.indexOf("@");
    if (at < 1 || at > 64) return false;                // local part 1-64
    const domain = s.slice(at + 1);
    const tld = domain.split(".").pop() || "";
    if (tld.length < 2 || tld.length > 24) return false;
    return true;
};

const isValidUrl = (s: string): boolean => {
    // Must have a host with at least one dot AND end-of-host after a TLD-ish
    // segment. Reject obvious garbage like "https://." or "http://abc".
    const m = s.match(/^https?:\/\/([^\s\/]+)/i);
    if (!m) return false;
    const host = m[1];
    if (host.length < 4 || host.startsWith(".") || host.endsWith(".")) return false;
    if (!host.includes(".")) return false;
    const lastSeg = host.split(".").pop() || "";
    if (lastSeg.length < 2 || lastSeg.length > 24) return false;
    return true;
};

export const extractSmartLinks = (text: string): SmartLink[] => {
    const out: SmartLink[] = [];
    const seen = new Set<string>();
    const push = (type: SmartLink["type"], raw: string) => {
        const v = raw.trim().replace(/[.,;:!?)\]]+$/, "");
        if (!v || seen.has(type + ":" + v)) return;
        seen.add(type + ":" + v);
        out.push({ type, value: v });
    };
    for (const m of text.matchAll(URL_RE)) {
        const v = m[0].replace(/[.,;:!?)\]]+$/, "");
        if (isValidUrl(v)) push("url", v);
    }
    for (const m of text.matchAll(EMAIL_RE)) {
        if (isValidEmail(m[0])) push("email", m[0]);
    }
    // Track digit-only signature so the same phone matched by two patterns
    // (e.g. CN mobile + intl) isn't surfaced twice.
    const phoneDigitsSeen = new Set<string>();
    for (const re of PHONE_PATTERNS) {
        for (const m of text.matchAll(re)) {
            const matched = m[0];
            if (isMonotonicOrRepeated(matched)) continue;
            const digits = matched.replace(/\D/g, "");
            if (digits.length < 7 || digits.length > 15) continue;
            if (phoneDigitsSeen.has(digits)) continue;
            phoneDigitsSeen.add(digits);
            push("phone", matched);
        }
    }
    return out;
};
