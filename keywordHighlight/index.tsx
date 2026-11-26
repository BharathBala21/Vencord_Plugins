/*
 * KeywordHighlight — a Vencord user plugin
 * Highlights your keywords inside messages.
 * Copyright (c) 2026 pirate_6581
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { Message } from "@vencord/discord-types";
import { Menu, showToast, useEffect, UserStore, useRef } from "@webpack/common";

/*
 * How it works:
 * Editing Discord's message DOM directly can crash React, so instead this uses the
 * CSS Custom Highlight API: we create Ranges over the matching text and register them
 * in CSS.highlights. The browser paints them via ::highlight() without touching the DOM.
 */

const HIGHLIGHT_NAME = "vc-keyword-highlight";
const DEFAULT_COLOR = "#f0b232";

const settings = definePluginSettings({
    keywords: {
        type: OptionType.STRING,
        description: "Words or phrases to highlight, separated by commas (e.g. exam, deadline, pirate)",
        default: "",
    },
    wholeWord: {
        type: OptionType.BOOLEAN,
        description: "Only match whole words (\"cat\" won't match \"category\")",
        default: true,
    },
    caseSensitive: {
        type: OptionType.BOOLEAN,
        description: "Match uppercase/lowercase exactly",
        default: false,
    },
    ignoreOwnMessages: {
        type: OptionType.BOOLEAN,
        description: "Don't highlight words in messages you sent",
        default: true,
    },
    color: {
        type: OptionType.STRING,
        description: "Highlight color (any CSS color, e.g. #f0b232 or orange)",
        default: DEFAULT_COLOR,
        onChange: () => applyStyle(),
    },
});

/* ---------- styling ---------- */

let styleEl: HTMLStyleElement | null = null;

function applyStyle() {
    styleEl ??= document.head.appendChild(document.createElement("style"));
    const color = (settings.store.color || DEFAULT_COLOR).replace(/[;{}<>]/g, "");
    styleEl.textContent = `
        ::highlight(${HIGHLIGHT_NAME}) {
            background-color: color-mix(in srgb, ${color} 40%, transparent);
            color: inherit;
        }
    `;
}

/* ---------- matching ---------- */

function parseKeywords(raw: string) {
    return [...new Set(raw.split(",").map(k => k.trim()).filter(Boolean))];
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Rebuilding the regex for every message would be wasteful, so cache it per settings combo
let cacheKey = "";
let cachedRegex: RegExp | null = null;

function getRegex(keywords: string, wholeWord: boolean, caseSensitive: boolean) {
    const key = `${keywords}\0${wholeWord}\0${caseSensitive}`;
    if (key === cacheKey) return cachedRegex;

    const list = parseKeywords(keywords);
    cacheKey = key;
    cachedRegex = null;
    if (!list.length) return null;

    // Longest first so "new york" wins over "new"
    const alternation = list.sort((a, b) => b.length - a.length).map(escapeRegex).join("|");
    const source = wholeWord
        ? `(?<![\\p{L}\\p{N}_])(?:${alternation})(?![\\p{L}\\p{N}_])` // Unicode-aware word boundary
        : `(?:${alternation})`;

    cachedRegex = new RegExp(source, caseSensitive ? "gu" : "giu");
    return cachedRegex;
}

/* ---------- highlighting ---------- */

let highlight: Highlight | null = null;

function getHighlight() {
    if (!highlight) {
        highlight = new Highlight();
        CSS.highlights.set(HIGHLIGHT_NAME, highlight);
    }
    return highlight;
}

/** Find all keyword matches in an element's text and return Ranges covering them. */
function findRanges(root: Element, regex: RegExp) {
    // Collect text nodes, skipping spoilers so we don't reveal hidden text
    const nodes: Text[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: n => n.parentElement?.closest('[class*="spoilerContent"]')
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT,
    });
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    if (!nodes.length) return [];

    // Join all text so phrases split by formatting (e.g. "new **york**") still match
    const starts: number[] = [];
    let full = "";
    for (const n of nodes) {
        starts.push(full.length);
        full += n.data;
    }

    // Map an index in `full` to the text node + offset it falls in
    const locate = (index: number, isEnd: boolean) => {
        let i = 0;
        while (i + 1 < nodes.length && (isEnd ? starts[i + 1] < index : starts[i + 1] <= index)) i++;
        return [nodes[i], index - starts[i]] as const;
    };

    const ranges: Range[] = [];
    for (const m of full.matchAll(regex)) {
        const range = new Range();
        range.setStart(...locate(m.index!, false));
        range.setEnd(...locate(m.index! + m[0].length, true));
        ranges.push(range);
    }
    return ranges;
}

function KeywordHighlighter({ message }: { message: Message; }) {
    const ref = useRef<HTMLSpanElement>(null);
    const { keywords, wholeWord, caseSensitive, ignoreOwnMessages } = settings.use(
        ["keywords", "wholeWord", "caseSensitive", "ignoreOwnMessages"]
    );

    const isOwn = ignoreOwnMessages && message.author?.id === UserStore.getCurrentUser()?.id;
    const regex = isOwn ? null : getRegex(keywords, wholeWord, caseSensitive);

    // Re-run when the message is edited or settings change
    useEffect(() => {
        if (!regex || !ref.current) return;

        // Scope the search to this message's row, so the same message shown in
        // search results or a popout is handled separately
        const row = ref.current.closest('[id^="chat-messages-"]') ?? ref.current.parentElement?.parentElement;
        const content = row?.querySelector(`#message-content-${message.id}`);
        if (!content) return;

        const ranges = findRanges(content, regex);
        const hl = getHighlight();
        ranges.forEach(r => hl.add(r));

        return () => ranges.forEach(r => hl.delete(r));
    }, [regex, message.id, message.content, message.editedTimestamp]);

    return <span ref={ref} hidden />;
}

/* ---------- right-click: add / remove keyword ---------- */

function isKeyword(word: string) {
    const norm = (s: string) => settings.store.caseSensitive ? s : s.toLowerCase();
    return parseKeywords(settings.store.keywords).some(k => norm(k) === norm(word));
}

function addKeyword(word: string) {
    settings.store.keywords = [...parseKeywords(settings.store.keywords), word].join(", ");
    showToast({ text: `Now highlighting "${word}"`, variant: "success" });
}

function removeKeyword(word: string) {
    const needle = word.toLowerCase();
    settings.store.keywords = parseKeywords(settings.store.keywords).filter(k => k.toLowerCase() !== needle).join(", ");
    showToast({ text: `Stopped highlighting "${word}"`, variant: "success" });
}

const messageCtxPatch: NavContextMenuPatchCallback = children => {
    const selection = document.getSelection()?.toString().trim().replace(/\s+/g, " ");
    if (!selection || selection.length > 50 || selection.includes(",")) return;

    const shown = selection.length > 25 ? selection.slice(0, 25) + "…" : selection;
    const already = isKeyword(selection);

    const item = (
        <Menu.MenuItem
            id="vc-kh-toggle"
            label={already ? `Stop highlighting "${shown}"` : `Highlight "${shown}"`}
            action={() => already ? removeKeyword(selection) : addKeyword(selection)}
        />
    );

    const group = findGroupChildrenByChildId("copy-text", children);
    if (group) group.splice(group.findIndex(c => c?.props?.id === "copy-text") + 1, 0, item);
    else children.push(<Menu.MenuGroup>{item}</Menu.MenuGroup>);
};

/* ---------- plugin ---------- */

export default definePlugin({
    name: "KeywordHighlight",
    description: "Highlights your keywords inside messages. Add words in settings, or select text and right-click → Highlight",
    authors: [{ name: "pirate_6581", id: 474590209527382056n }],
    settings,

    contextMenus: {
        message: messageCtxPatch,
    },

    renderMessageAccessory: props => <KeywordHighlighter message={props.message} />,

    start() {
        applyStyle();
        getHighlight();
    },

    stop() {
        CSS.highlights.delete(HIGHLIGHT_NAME);
        highlight = null;
        styleEl?.remove();
        styleEl = null;
    },
});
