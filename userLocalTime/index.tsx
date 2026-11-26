/*
 * UserLocalTime — a Vencord user plugin
 * Set a timezone for anyone (right-click them) and see their local time next to their name in chat.
 * Copyright (c) 2026 pirate_6581
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { RenderModalProps, User } from "@vencord/discord-types";
import { Menu, Modal, openModal, SearchableSelect, useEffect, useMemo, useState } from "@webpack/common";

const STORE_KEY = "UserLocalTime_zones";

const settings = definePluginSettings({
    clock: {
        type: OptionType.SELECT,
        description: "Clock format",
        options: [
            { label: "Your system default", value: "auto", default: true },
            { label: "12-hour (3:12 AM)", value: "12" },
            { label: "24-hour (03:12)", value: "24" },
        ],
    },
});

// userId -> IANA timezone like "Asia/Kolkata"
let zones: Record<string, string> = {};
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(l => l());

async function setZone(userId: string, zone: string | null) {
    if (zone) zones = { ...zones, [userId]: zone };
    else {
        const { [userId]: _, ...rest } = zones;
        zones = rest;
    }
    notify();
    await DataStore.set(STORE_KEY, zones);
}

// Re-renders when timezones change, and right as each minute changes
function useLiveZones() {
    const [, rerender] = useState(0);
    useEffect(() => {
        const update = () => rerender(n => n + 1);
        listeners.add(update);

        let interval: ReturnType<typeof setInterval>;
        const timeout = setTimeout(() => {
            update();
            interval = setInterval(update, 60_000);
        }, 60_000 - (Date.now() % 60_000) + 50);

        return () => {
            listeners.delete(update);
            clearTimeout(timeout);
            clearInterval(interval);
        };
    }, []);
    return zones;
}

function formatTime(zone: string) {
    const { clock } = settings.store;
    return new Intl.DateTimeFormat(undefined, {
        timeZone: zone,
        hour: "numeric",
        minute: "2-digit",
        hour12: clock === "auto" ? undefined : clock === "12",
    }).format(new Date());
}

function zoneName(zone: string, style: "long" | "longOffset") {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: style })
        .formatToParts(new Date())
        .find(p => p.type === "timeZoneName")?.value ?? zone;
}

// Minutes ahead of UTC right now (handles daylight saving)
function utcOffsetMinutes(zone: string) {
    const match = /GMT([+-])(\d{2}):(\d{2})/.exec(zoneName(zone, "longOffset"));
    if (!match) return 0;
    const minutes = Number(match[2]) * 60 + Number(match[3]);
    return match[1] === "-" ? -minutes : minutes;
}

function LocalTimeTag({ user }: { user: User; }) {
    const zone = useLiveZones()[user.id];
    if (!zone) return null;
    return <span className="vc-localtime">{formatTime(zone)}</span>;
}

function TimezoneModal({ rootProps, user }: { rootProps: RenderModalProps; user: User; }) {
    const [value, setValue] = useState<string | undefined>(zones[user.id]);

    // Labels include the full zone name so you can search "India", "Pacific", "Tokyo", etc.
    const options = useMemo(() =>
        Intl.supportedValuesOf("timeZone")
            .map(zone => ({
                value: zone,
                offset: utcOffsetMinutes(zone),
                label: `${zone.replaceAll("_", " ")} — ${zoneName(zone, "long")} (${zoneName(zone, "longOffset").replace("GMT", "UTC")})`,
            }))
            .sort((a, b) => a.offset - b.offset || a.value.localeCompare(b.value)),
    []);

    return (
        <Modal
            {...rootProps}
            title={`Timezone for ${user.globalName ?? user.username}`}
            actions={[{
                text: "Save",
                variant: "primary",
                disabled: !value,
                onClick: () => {
                    setZone(user.id, value!);
                    rootProps.onClose();
                },
            }]}
        >
            <SearchableSelect
                options={options}
                value={value}
                placeholder="Search a city or timezone"
                maxVisibleItems={7}
                closeOnSelect={true}
                onChange={v => setValue(v)}
            />
        </Modal>
    );
}

const userContextPatch: NavContextMenuPatchCallback = (children, { user }: { user?: User; }) => {
    if (!user) return;
    const hasZone = user.id in zones;

    children.push(
        <Menu.MenuGroup>
            <Menu.MenuItem
                id="vc-localtime-set"
                label={hasZone ? "Change Timezone…" : "Set Timezone…"}
                action={() => openModal(props => <TimezoneModal rootProps={props} user={user} />)}
            />
            {hasZone && (
                <Menu.MenuItem
                    id="vc-localtime-remove"
                    label="Remove Timezone"
                    color="danger"
                    action={() => setZone(user.id, null)}
                />
            )}
        </Menu.MenuGroup>
    );
};

export default definePlugin({
    name: "UserLocalTime",
    description: "Right-click anyone to set their timezone, then see their local time next to their name in chat",
    authors: [{ name: "pirate_6581", id: 474590209527382056n }],
    settings,

    contextMenus: {
        "user-context": userContextPatch,
        "user-profile-actions": userContextPatch,
    },

    renderMessageDecoration: ({ message }) => message?.author ? <LocalTimeTag user={message.author} /> : null,

    async start() {
        zones = await DataStore.get<Record<string, string>>(STORE_KEY) ?? {};
        notify();
    },
});
