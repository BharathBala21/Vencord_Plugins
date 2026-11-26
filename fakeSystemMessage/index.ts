/*
 * FakeSystemMessage — a Vencord user plugin
 * Start a message with "!sys" and it's sent as a colorful ANSI block that looks like an official system notice.
 * Copyright (c) 2026 pirate_6581
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { sendBotMessage } from "@api/Commands";
import definePlugin from "@utils/types";

// "!sys text", "!syswarn text", "!sysban text", "!sysok text". Case-insensitive.
const TRIGGER = /^!sys(warn|ban|ok)?\s+([\s\S]+)$/i;

const MAX_LENGTH = 2000;

const ESC = "\u001b";
const ansi = (codes: string, text: string) => `${ESC}[${codes}m${text}${ESC}[0m`;

// Discord's ANSI palette: 31 red, 32 green, 33 yellow, 34 blue, 30 gray, 37 white; 1 = bold
const STYLES = {
    info: { color: "34", title: "ℹ SYSTEM NOTICE" },
    warn: { color: "33", title: "⚠ WARNING" },
    ban: { color: "31", title: "⛔ MODERATION ACTION" },
    ok: { color: "32", title: "✔ SUCCESS" },
};

function buildNotice(kind: keyof typeof STYLES, text: string) {
    const { color, title } = STYLES[kind];
    const time = new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

    // A stray ``` would close the code block early, so swap backticks for a look-alike
    const lines = text.replace(/`/g, "ˋ").split("\n");
    const width = Math.min(Math.max(title.length + time.length + 6, ...lines.map(l => l.length)), 48);

    return [
        "```ansi",
        `${ansi(`1;${color}`, title)}  ${ansi("30", `[${time}]`)}`,
        ansi(color, "━".repeat(width)),
        ...lines.map(l => ansi("1;37", l)),
        "```",
    ].join("\n");
}

export default definePlugin({
    name: "FakeSystemMessage",
    description: 'Start a message with "!sys", "!syswarn", "!sysban" or "!sysok" to send it as an official-looking system notice',
    authors: [{ name: "pirate_6581", id: 474590209527382056n }],

    onBeforeMessageSend(channelId, msg) {
        const match = TRIGGER.exec(msg.content.trim());
        if (!match) return;

        const kind = (match[1]?.toLowerCase() ?? "info") as keyof typeof STYLES;
        const content = buildNotice(kind, match[2].trim());

        if (content.length > MAX_LENGTH) {
            sendBotMessage(channelId, { content: `That notice is too long (${content.length}/${MAX_LENGTH} characters). Try something shorter.` });
            return { cancel: true };
        }

        msg.content = content;
    },
});
