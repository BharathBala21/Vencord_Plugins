/*
 * SecondTimestamps — a Vencord user plugin
 * Shows seconds in message timestamps (e.g. "Today at 3:41:27 PM").
 * Copyright (c) 2026 pirate_6581
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";

/*
 * How this works:
 * Discord compiles moment-style format tokens into Intl.DateTimeFormat calls.
 * In that compiler, "LT" (time only) becomes { timeStyle: "short" } -> 3:41 PM,
 * while "LTS" becomes { timeStyle: "medium" } -> 3:41:27 PM.
 * Message timestamps (and "Today at ...", "Yesterday at ...", "11/24/2026 3:41 PM")
 * all go through "LT" / "L LT", so switching those to "medium" adds seconds
 * everywhere while still respecting your locale and Discord's 12h/24h setting.
 */

const settings = definePluginSettings({
    fullDateTooltips: {
        type: OptionType.BOOLEAN,
        description: "Also show seconds in the full-date tooltip when hovering a timestamp",
        default: true,
        restartNeeded: true,
    },
});

export default definePlugin({
    name: "SecondTimestamps",
    description: "Shows seconds in message timestamps instead of just hours and minutes",
    authors: [{ name: "pirate_6581", id: 474590209527382056n }],
    settings,

    patches: [
        {
            find: '"L LT"===',
            replacement: [
                {
                    // "LT" -> time with seconds ("Today at 3:41:27 PM", compact mode, hover times)
                    match: /("LT"===\i\?\i=)"short"/,
                    replace: '$1"medium"',
                },
                {
                    // "L LT" -> date + time with seconds (messages older than yesterday)
                    match: /("L LT"===\i\?\(\i="short",\i=)"short"/,
                    replace: '$1"medium"',
                },
            ],
        },
        {
            find: '"L LT"===',
            predicate: () => settings.store.fullDateTooltips,
            replacement: [
                {
                    match: /("LLL"===\i\?\(\i="long",\i=)"short"/,
                    replace: '$1"medium"',
                },
                {
                    match: /("LLLL"===\i\?\(\i="full",\i=)"short"/,
                    replace: '$1"medium"',
                },
            ],
        },
    ],
});
