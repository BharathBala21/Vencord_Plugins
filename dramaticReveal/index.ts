/*
 * DramaticReveal — a Vencord user plugin
 * Start a message with "!reveal" and it's sent hidden behind a spoiler per letter
 * (or per word with "!revealw"), so people have to click through it one piece at a time.
 * Copyright (c) 2026 pirate_6581
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { sendBotMessage } from "@api/Commands";
import definePlugin from "@utils/types";

// "!reveal text" hides letters, "!revealw text" hides words. Case-insensitive.
const TRIGGER = /^!reveal(w)?\s+([\s\S]+)$/i;

const MAX_LENGTH = 2000; // Discord's message limit for non-Nitro users

// Things that must stay whole or they break: custom emoji, mentions, channels, roles, timestamps, links
const ATOMIC_TOKEN = /<a?:\w+:\d+>|<@[!&]?\d+>|<#\d+>|<t:\d+(?::\w)?>|https?:\/\/\S+/g;

// Escape markdown so a lone "*" or "|" inside a spoiler can't break the formatting
const escapeMarkdown = (s: string) => s.replace(/[\\|*_~`>#-]/g, "\\$&");

const spoiler = (s: string) => `||${s}||`;

/** Split text into pieces, keeping emoji (incl. flags/skin tones) and atomic tokens intact. */
function splitPieces(text: string, mode: "letters" | "words") {
    const pieces: { text: string; isSpace: boolean; }[] = [];
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

    const pushPlain = (chunk: string) => {
        if (mode === "words") {
            // Pipes become their own piece so a word never ends in "\|" right before "||"
            for (const part of chunk.split(/(\s+|\|)/)) {
                if (part) pieces.push({ text: escapeMarkdown(part), isSpace: /^\s+$/.test(part) });
            }
        } else {
            for (const { segment } of segmenter.segment(chunk)) {
                pieces.push({ text: escapeMarkdown(segment), isSpace: /^\s$/.test(segment) });
            }
        }
    };

    let last = 0;
    for (const m of text.matchAll(ATOMIC_TOKEN)) {
        pushPlain(text.slice(last, m.index));
        pieces.push({ text: m[0], isSpace: false });
        last = m.index! + m[0].length;
    }
    pushPlain(text.slice(last));

    return pieces;
}

function buildReveal(text: string, mode: "letters" | "words") {
    // Whitespace stays outside spoilers so line breaks and spacing look normal.
    // A "|" is also left outside: "||\|||" could be read as a spoiler closing early.
    return splitPieces(text, mode)
        .map(p => p.isSpace || p.text === "\\|" ? p.text : spoiler(p.text))
        .join("");
}

export default definePlugin({
    name: "DramaticReveal",
    description: 'Start a message with "!reveal" (letters) or "!revealw" (words) to send it hidden behind spoilers',
    authors: [{ name: "pirate_6581", id: 474590209527382056n }],

    // Runs right before any message you send, so it works in every channel you can type in
    onBeforeMessageSend(channelId, msg) {
        const match = TRIGGER.exec(msg.content.trim());
        if (!match) return;

        const text = match[2].trim();
        let mode: "letters" | "words" = match[1] ? "words" : "letters";
        let content = buildReveal(text, mode);

        // Letter mode is ~5x longer than the original; fall back to words if it's too long
        if (content.length > MAX_LENGTH && mode === "letters") {
            mode = "words";
            content = buildReveal(text, mode);
            if (content.length <= MAX_LENGTH)
                sendBotMessage(channelId, { content: "Too long for letter-by-letter, so I hid it word by word instead." });
        }

        if (content.length > MAX_LENGTH) {
            sendBotMessage(channelId, { content: `That message is too long to reveal dramatically (${content.length}/${MAX_LENGTH} characters). Try something shorter.` });
            return { cancel: true };
        }

        msg.content = content;
    },
});
