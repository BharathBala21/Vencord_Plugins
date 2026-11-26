/*
 * RdrGang — a Vencord user plugin
 * Everyone becomes a member of the Van der Linde gang: names and avatars are swapped
 * for Red Dead Redemption 2 characters. Only on your screen.
 * Copyright (c) 2026 pirate_6581
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { GuildMemberStore, IconUtils, RelationshipStore, UserStore, UsernameUtils } from "@webpack/common";

import { GANG } from "./gang";

const logger = new Logger("RdrGang");

const settings = definePluginSettings({
    includeMe: {
        type: OptionType.BOOLEAN,
        description: "Turn yourself into a gang member too",
        default: false,
        onChange: refresh,
    },
});

// Same user always gets the same character
function characterFor(userId: string | undefined) {
    if (!userId) return null;
    if (!settings.store.includeMe && userId === UserStore.getCurrentUser()?.id) return null;

    let hash = 0;
    for (const c of userId) hash = (hash * 31 + c.charCodeAt(0)) | 0;
    return GANG[Math.abs(hash) % GANG.length];
}

const restorers: (() => void)[] = [];

// Wraps obj[key] with a replacement; skipped quietly if Discord renamed the method
function override(obj: any, key: string, wrap: (orig: (...args: any[]) => any) => (...args: any[]) => any) {
    const orig = obj?.[key];
    if (typeof orig !== "function") return logger.warn(`Can't find ${key}, skipping it`);

    const hadOwn = Object.hasOwn(obj, key);
    // Stores use `this` internally (getMember calls this.getTrueMember), so keep it bound
    const bound = orig.bind(obj);
    const wrapped = wrap(bound);
    obj[key] = (...args: any[]) => {
        try {
            return wrapped(...args);
        } catch (e) {
            logger.error(`${key} override failed, using Discord's original`, e);
            return bound(...args);
        }
    };
    restorers.push(() => hadOwn ? obj[key] = orig : delete obj[key]);
}

// Guild members carry their own nickname and server avatar, so hand out a disguised copy
const disguisedMembers = new WeakMap<object, any>();
function disguiseMember(member: any) {
    const character = characterFor(member?.userId);
    if (!character) return member;

    let copy = disguisedMembers.get(member);
    if (!copy) disguisedMembers.set(member, copy = { ...member, nick: character.name, avatar: null });
    return copy;
}

function refresh() {
    for (const store of [UserStore, GuildMemberStore, RelationshipStore] as any[]) {
        try { store.emitChange(); } catch { }
    }
}

export default definePlugin({
    name: "RdrGang",
    description: "Everyone becomes a Red Dead Redemption 2 character (name and avatar). Only you see it",
    authors: [{ name: "pirate_6581", id: 474590209527382056n }],
    settings,

    start() {
        const avatar = (userId: string | undefined) => characterFor(userId)?.avatar;
        const name = (user: any) => characterFor(user?.id)?.name;

        // Avatars
        override(IconUtils, "getUserAvatarURL", orig => (user, ...rest) => avatar(user?.id) ?? orig(user, ...rest));
        override(IconUtils, "getUserAvatarSource", orig => (user, ...rest) => {
            const uri = avatar(user?.id);
            return uri ? { uri } : orig(user, ...rest);
        });
        override(IconUtils, "getGuildMemberAvatarURLSimple", orig => (opts, ...rest) => avatar(opts?.userId) ?? orig(opts, ...rest));
        override(IconUtils, "getGuildMemberAvatarURL", orig => (member, ...rest) => avatar(member?.userId) ?? orig(member, ...rest));
        override(IconUtils, "getGuildMemberAvatarSource", orig => (member, ...rest) => {
            const uri = avatar(member?.userId);
            return uri ? { uri } : orig(member, ...rest);
        });

        // Names. useName is a React hook, so the original always runs to keep hook order stable
        override(UsernameUtils, "getName", orig => (user, ...rest) => name(user) ?? orig(user, ...rest));
        override(UsernameUtils, "useName", orig => (user, ...rest) => {
            const real = orig(user, ...rest);
            return name(user) ?? real;
        });
        override(UsernameUtils, "getGlobalName", orig => (user, ...rest) => name(user) ?? orig(user, ...rest));
        override(UsernameUtils, "getFormattedName", orig => (user, ...rest) => name(user) ?? orig(user, ...rest));

        // Server nicknames and friend nicknames win over global names, so cover those too
        override(GuildMemberStore, "getMember", orig => (...args) => disguiseMember(orig(...args)));
        override(GuildMemberStore, "getNick", orig => (guildId, userId) => characterFor(userId)?.name ?? orig(guildId, userId));
        override(RelationshipStore, "getNickname", orig => userId => characterFor(userId)?.name ?? orig(userId));

        refresh();
    },

    stop() {
        restorers.splice(0).reverse().forEach(r => r());
        refresh();
    },
});
