/*
 * WordCount — a Vencord user plugin
 * Right-click a message to see its word and character count.
 * Copyright (c) 2026 pirate_6581
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import definePlugin from "@utils/types";
import { Message } from "@vencord/discord-types";
import { Menu } from "@webpack/common";

function getMessageContent(message: Message) {
    // Forwarded messages keep their text in a snapshot instead of message.content
    return message.content || message.messageSnapshots?.[0]?.message.content || "";
}

function countWords(text: string) {
    const trimmed = text.trim();
    return trimmed ? trimmed.split(/\s+/).length : 0;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const messageCtxPatch: NavContextMenuPatchCallback = (children, { message }: { message: Message; }) => {
    // If you highlighted part of the message, count only the selection
    const selection = document.getSelection()?.toString();
    const text = selection || getMessageContent(message);
    if (!text) return;

    const words = countWords(text);
    const chars = [...text].length; // counts emoji as 1 character, not 2

    const label = `${selection ? "Selection: " : ""}${plural(words, "word")} · ${plural(chars, "character")}`;

    const item = <Menu.MenuItem id="vc-word-count" label={label} />;

    // Put it right under "Copy Text"; fall back to the end of the menu
    const group = findGroupChildrenByChildId("copy-text", children);
    if (group) {
        group.splice(group.findIndex(c => c?.props?.id === "copy-text") + 1, 0, item);
    } else {
        children.push(<Menu.MenuGroup>{item}</Menu.MenuGroup>);
    }
};

export default definePlugin({
    name: "WordCount",
    description: "Shows the word and character count of a message in its right-click menu",
    authors: [{ name: "pirate_6581", id: 474590209527382056n }],

    contextMenus: {
        message: messageCtxPatch,
    },
});
