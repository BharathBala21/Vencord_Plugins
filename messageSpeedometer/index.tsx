/*
 * MessageSpeedometer — a Vencord user plugin
 * Shows how fast the current channel is moving (messages per minute) next to the message box,
 * with a sparkline of the last 10 minutes.
 * Copyright (c) 2026 pirate_6581
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { sendBotMessage } from "@api/Commands";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { IconComponent, OptionType } from "@utils/types";
import { MessageStore, useEffect, useState } from "@webpack/common";

const WINDOW_MS = 10 * 60_000;           // history kept per channel
const BUCKET_MS = 30_000;                // sparkline resolution
const BUCKETS = WINDOW_MS / BUCKET_MS;   // 20 bars

const LEVELS = [
    { min: 30, name: "🔥 popping off", className: "vc-speedo-fire" },
    { min: 15, name: "busy", className: "vc-speedo-busy" },
    { min: 5, name: "active", className: "vc-speedo-active" },
    { min: 0, name: "quiet", className: "vc-speedo-quiet" },
];

const settings = definePluginSettings({
    showSparkline: {
        type: OptionType.BOOLEAN,
        description: "Show a mini graph of the last 10 minutes next to the number",
        default: true,
    },
    hideWhenDead: {
        type: OptionType.BOOLEAN,
        description: "Hide the speedometer when nobody has talked for 10 minutes",
        default: false,
    },
});

// channelId -> (messageId -> sent time). Kept while Discord is open, so switching
// channels back and forth doesn't lose history that MessageStore may have unloaded.
const history = new Map<string, Map<string, number>>();

function getTimes(channelId: string, now: number) {
    let seen = history.get(channelId);
    if (!seen) history.set(channelId, seen = new Map());

    // Merge whatever Discord has loaded for this channel (covers new messages too)
    for (const msg of MessageStore.getMessages(channelId)?._array ?? []) {
        const sent = +new Date(msg.timestamp as any);
        if (now - sent <= WINDOW_MS) seen.set(msg.id, sent);
    }

    for (const [id, sent] of seen) {
        if (now - sent > WINDOW_MS) seen.delete(id);
    }

    return [...seen.values()];
}

function getStats(channelId: string) {
    const now = Date.now();
    const times = getTimes(channelId, now);

    const buckets = new Array<number>(BUCKETS).fill(0);
    for (const t of times) {
        const age = now - t;
        const index = BUCKETS - 1 - Math.floor(age / BUCKET_MS);
        if (index >= 0 && index < BUCKETS) buckets[index]++;
    }

    const lastMinute = times.filter(t => now - t <= 60_000).length;
    const lastFive = times.filter(t => now - t <= 5 * 60_000).length;

    // Busiest 1-minute stretch (two neighbouring 30s buckets)
    let peak = 0;
    for (let i = 1; i < BUCKETS; i++) peak = Math.max(peak, buckets[i - 1] + buckets[i]);

    const level = LEVELS.find(l => lastMinute >= l.min)!;
    return { lastMinute, lastFive, lastTen: times.length, peak, buckets, level };
}

function Sparkline({ buckets }: { buckets: number[]; }) {
    const w = 40, h = 16;
    const max = Math.max(...buckets, 1);
    const points = buckets
        .map((v, i) => `${(i / (buckets.length - 1)) * w},${h - 1 - (v / max) * (h - 2)}`)
        .join(" ");

    return (
        <svg className="vc-speedo-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
            <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        </svg>
    );
}

const SpeedometerIcon: IconComponent = ({ height = 20, width = 20, className }) => (
    <svg width={width} height={height} viewBox="0 0 24 24" className={className}>
        <path fill="currentColor" d="M12 4a10 10 0 0 0-8.66 15h17.32A10 10 0 0 0 12 4Zm0 2a8 8 0 0 1 7.42 11H4.58A8 8 0 0 1 12 6Zm4.24 2.76-4.95 4.95a1.5 1.5 0 1 0 2.12 2.12l4.24-5.66-1.41-1.41Z" />
    </svg>
);

const SpeedometerButton: ChatBarButtonFactory = ({ isMainChat, channel }) => {
    const [, rerender] = useState(0);
    const { showSparkline, hideWhenDead } = settings.use(["showSparkline", "hideWhenDead"]);

    useEffect(() => {
        const timer = setInterval(() => rerender(n => n + 1), 1000);
        return () => clearInterval(timer);
    }, []);

    if (!isMainChat) return null;

    const stats = getStats(channel.id);
    if (hideWhenDead && stats.lastTen === 0) return null;

    const tooltip = `${stats.level.name} · ${stats.lastMinute} in the last minute · ${stats.lastFive} in 5 min · peak ${stats.peak}/min`;

    return (
        <ChatBarButton
            tooltip={tooltip}
            onClick={() => sendBotMessage(channel.id, {
                content: [
                    `**Channel speed:** ${stats.level.name}`,
                    `Last minute: **${stats.lastMinute}** messages`,
                    `Last 5 minutes: **${stats.lastFive}** (${(stats.lastFive / 5).toFixed(1)}/min average)`,
                    `Last 10 minutes: **${stats.lastTen}**`,
                    `Busiest minute: **${stats.peak}**`,
                ].join("\n"),
            })}
        >
            <div className={`vc-speedo ${stats.level.className}`}>
                {showSparkline && <Sparkline buckets={stats.buckets} />}
                <span className="vc-speedo-rate">{stats.lastMinute}/m</span>
            </div>
        </ChatBarButton>
    );
};

export default definePlugin({
    name: "MessageSpeedometer",
    description: "Shows how many messages per minute the current channel is getting, with a 10-minute graph",
    authors: [{ name: "pirate_6581", id: 474590209527382056n }],
    settings,

    chatBarButton: {
        icon: SpeedometerIcon,
        render: SpeedometerButton,
    },

    stop() {
        history.clear();
    },
});
