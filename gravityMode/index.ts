/*
 * GravityMode — a Vencord user plugin
 * Ctrl+Shift+click a message to make just that one fall (or get kicked, or shot), or press Ctrl+Shift+G to drop
 * every message on screen. Grab messages with the mouse and throw them around. Esc restores.
 * Purely visual and local: nothing is sent, and Discord's own elements are never modified.
 * Copyright (c) 2026 pirate_6581
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { findCssClassesLazy } from "@webpack";

const MessagesClasses = findCssClassesLazy("messagesWrapper", "navigationDescription");

const settings = definePluginSettings({
    clickAction: {
        type: OptionType.SELECT,
        description: "What Ctrl+Shift+click does to a message",
        options: [
            { label: "Fall to the bottom of the chat", value: "fall", default: true },
            { label: "Get kicked out of the chat by a boot", value: "kick" },
            { label: "Get shot with a shotgun and crumble", value: "shoot" },
            { label: "Western showdown: slow-mo, mark your shots, then fire", value: "showdown" },
        ],
    },
});

/* ---------- physics tuning ---------- */
const GRAVITY = 2200;      // px/s²
const BOUNCE = 0.35;       // how much speed survives a bounce (0 = dead stop, 1 = superball)
const FRICTION = 0.85;     // horizontal speed kept per landing
const MAX_BODIES = 60;     // only the messages you can see, capped for performance
const SOLVER_STEPS = 4;    // more = stabler stacks
const MAX_SPEED = 3000;    // px/s

interface Body {
    el: HTMLElement;
    x: number; y: number;
    w: number; h: number;
    vx: number; vy: number;
    angle: number; av: number;
    supported: boolean;
    frozen: boolean;  // waiting to be kicked: doesn't move, but others can land on it
    flying: boolean;  // kicked: ignores walls and other messages until it leaves the screen
}

let overlay: HTMLDivElement | null = null;
let bodies: Body[] = [];
let rafId = 0;
let lastTime = 0;
let bounds = { w: 0, h: 0 };

// Mouse dragging state
let held: Body | null = null;
let grabOffset = { x: 0, y: 0 };
let pointerHistory: { x: number; y: number; t: number; }[] = [];

/* ---------- setup ---------- */

/** How wide the message's actual content is (messages are full-width rows, which would just stack like planks). */
function measureContentWidth(li: HTMLElement, liRect: DOMRect) {
    let maxRight = liRect.left;
    const walker = document.createTreeWalker(li, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    const range = document.createRange();

    while (walker.nextNode()) {
        const node = walker.currentNode;
        let rect: DOMRect | undefined;
        if (node.nodeType === Node.TEXT_NODE) {
            if (!node.textContent?.trim()) continue;
            range.selectNodeContents(node);
            rect = range.getBoundingClientRect();
        } else if (node instanceof HTMLImageElement || node instanceof HTMLVideoElement || node instanceof HTMLCanvasElement || node instanceof SVGSVGElement) {
            rect = node.getBoundingClientRect();
        }
        if (rect && rect.width > 0) maxRight = Math.max(maxRight, rect.right);
    }

    return Math.min(liRect.width, Math.max(120, maxRight - liRect.left + 16));
}

function cloneMessage(li: HTMLElement, area: DOMRect): Body | null {
    const rect = li.getBoundingClientRect();
    if (rect.height < 4 || rect.bottom < area.top || rect.top > area.bottom) return null;

    const w = measureContentWidth(li, rect);
    const el = li.cloneNode(true) as HTMLElement;

    // Duplicate ids would confuse Discord and other plugins
    el.removeAttribute("id");
    el.querySelectorAll("[id]").forEach(n => n.removeAttribute("id"));

    el.classList.add("vc-gravity-body");
    el.style.width = `${w}px`;
    el.style.height = `${rect.height}px`;

    return {
        el,
        x: rect.left - area.left,
        y: rect.top - area.top,
        w,
        h: rect.height,
        vx: (Math.random() - 0.5) * 300,
        vy: -Math.random() * 150,         // tiny hop before falling
        angle: 0,
        av: (Math.random() - 0.5) * 120,  // degrees per second
        supported: false,
        frozen: false,
        flying: false,
    };
}

// "all" = whole chat dropped (Ctrl+Shift+G), "single" = individual messages dropped (Ctrl+Shift+click)
let mode: "all" | "single" | null = null;

// Hides the originals of individually dropped messages. A stylesheet is used instead of
// touching the elements, because React would undo a class change on the next re-render.
let hiddenStyle: HTMLStyleElement | null = null;
const hiddenIds = new Set<string>();

const getWrapper = () => document.querySelector<HTMLElement>(`div.${MessagesClasses.messagesWrapper}`);

function createOverlay(wrapper: HTMLElement) {
    const area = wrapper.getBoundingClientRect();
    bounds = { w: area.width, h: area.height };

    overlay = document.createElement("div");
    overlay.className = "vc-gravity-overlay";
    Object.assign(overlay.style, {
        left: `${area.left}px`,
        top: `${area.top}px`,
        width: `${area.width}px`,
        height: `${area.height}px`,
    });
    overlay.addEventListener("pointerdown", onPointerDown);
    document.body.appendChild(overlay);

    lastTime = performance.now();
    rafId = requestAnimationFrame(tick);
    return area;
}

function addBody(b: Body) {
    bodies.push(b);
    overlay!.appendChild(b.el);
    render(b);
}

function dropAll() {
    disable();
    const wrapper = getWrapper();
    if (!wrapper) return;

    const area = createOverlay(wrapper);
    mode = "all";
    document.body.classList.add("vc-gravity-all");

    [...wrapper.querySelectorAll<HTMLElement>('li[id^="chat-messages-"]')]
        .map(li => cloneMessage(li, area))
        .filter((b): b is Body => b !== null)
        .slice(-MAX_BODIES)
        .forEach(addBody);
}

function dropOne(li: HTMLElement, action: string, clickX: number, clickY: number) {
    if (mode === "all" || hiddenIds.has(li.id)) return;
    if (action === "showdown" && showdown) return;

    const wrapper = getWrapper();
    if (!wrapper) return;

    const area = overlay ? wrapper.getBoundingClientRect() : createOverlay(wrapper);
    mode = "single";

    const body = cloneMessage(li, area);
    if (!body) return;
    addBody(body);
    if (action === "kick") kick(body);
    else if (action === "shoot") shoot(body, clickX - area.left, clickY - area.top);
    else if (action === "showdown") startShowdown(body, clickX - area.left, clickY - area.top);

    hiddenIds.add(li.id);
    hiddenStyle ??= document.head.appendChild(document.createElement("style"));
    hiddenStyle.textContent = [...hiddenIds].map(id => `#${CSS.escape(id)}`).join(",") + "{visibility:hidden}";
}

/* ---------- kick ---------- */

// A cartoon boot pointing right; it swings from the top of its shaft like a leg from the hip
const BOOT_SVG = `<svg viewBox="0 0 96 100" width="96" height="100">
    <path d="M20 0H46V52Q46 60 54 62L84 70Q94 73 94 84V92H20Z" fill="#8a5530"/>
    <path d="M46 56Q46 62 54 64L84 72Q90 74 92 80L60 74Q48 70 46 62Z" fill="#a8693d"/>
    <rect x="16" y="0" width="34" height="10" rx="3" fill="#5c3720"/>
    <path d="M24 22H42M24 32H42M24 42H42" stroke="#e8d3b0" stroke-width="3" stroke-linecap="round"/>
    <rect x="18" y="90" width="78" height="9" rx="3" fill="#3a2414"/>
</svg>`;
const BOOT_PIVOT = { x: 33, y: 0 };    // top of the shaft
const BOOT_TOE = { x: 94, y: 84 };     // the part that hits the message
const IMPACT_ANGLE = -25;              // degrees, boot rotation at the moment of contact
const KICK_MS = 800;
const IMPACT_AT = 0.75;                // fraction of KICK_MS when the boot connects

function kick(body: Body) {
    body.frozen = true;
    body.vx = body.vy = body.av = 0;

    // Place the boot so its toe lands on the message's bottom-left at the impact angle
    const rad = IMPACT_ANGLE * Math.PI / 180;
    const dx = BOOT_TOE.x - BOOT_PIVOT.x, dy = BOOT_TOE.y - BOOT_PIVOT.y;
    const toeX = dx * Math.cos(rad) - dy * Math.sin(rad);
    const toeY = dx * Math.sin(rad) + dy * Math.cos(rad);
    const target = { x: body.x + 24, y: body.y + body.h - 6 };

    const boot = document.createElement("div");
    boot.className = "vc-gravity-boot";
    boot.innerHTML = BOOT_SVG;
    Object.assign(boot.style, {
        left: `${target.x - toeX - BOOT_PIVOT.x}px`,
        top: `${target.y - toeY - BOOT_PIVOT.y}px`,
        transformOrigin: `${BOOT_PIVOT.x}px ${BOOT_PIVOT.y}px`,
    });
    overlay!.appendChild(boot);

    boot.animate([
        { transform: "rotate(40deg)", opacity: 0, offset: 0 },
        { transform: "rotate(65deg)", opacity: 1, offset: 0.35 },                                  // wind up
        { transform: "rotate(78deg)", offset: 0.55, easing: "cubic-bezier(.6,0,1,1)" },             // pull back...
        { transform: `rotate(${IMPACT_ANGLE}deg)`, offset: IMPACT_AT },                             // ...and swing
        { transform: `rotate(${IMPACT_ANGLE - 12}deg)`, opacity: 1, offset: 0.85 },                 // follow-through
        { transform: `rotate(${IMPACT_ANGLE - 8}deg)`, opacity: 0, offset: 1 },
    ], { duration: KICK_MS, fill: "forwards" }).finished.then(() => boot.remove(), () => { });

    setTimeout(() => {
        if (!bodies.includes(body)) return; // gravity mode was turned off mid-kick
        body.frozen = false;
        body.flying = true;
        body.vx = 1700 + Math.random() * 600;
        body.vy = -(1000 + Math.random() * 400);
        body.av = 540 + Math.random() * 360;
        impactEffects(target.x, target.y);
    }, KICK_MS * IMPACT_AT);
}

function impactEffects(x: number, y: number) {
    const boom = document.createElement("div");
    boom.className = "vc-gravity-boom";
    boom.textContent = "💥";
    Object.assign(boom.style, { left: `${x}px`, top: `${y}px` });
    overlay!.appendChild(boom);
    boom.animate([
        { transform: "translate(-50%, -50%) scale(0.3)", opacity: 1 },
        { transform: "translate(-50%, -50%) scale(1.5)", opacity: 0 },
    ], { duration: 380, easing: "ease-out", fill: "forwards" }).finished.then(() => boom.remove(), () => { });

    shakeChat(1);
}

// Web Animations don't touch the element's attributes, so shaking Discord's chat is safe with React
function shakeChat(strength: number) {
    const k = strength;
    getWrapper()?.animate([
        { transform: "translate(0, 0)" },
        { transform: `translate(${-6 * k}px, ${3 * k}px)` },
        { transform: `translate(${5 * k}px, ${-4 * k}px)` },
        { transform: `translate(${-4 * k}px, ${-2 * k}px)` },
        { transform: `translate(${3 * k}px, ${2 * k}px)` },
        { transform: "translate(0, 0)" },
    ], { duration: 160 + 80 * k });
}

/* ---------- shotgun ---------- */

const CROSSHAIR_SVG = `<svg viewBox="0 0 64 64" width="64" height="64" fill="none" stroke="#ff3b3b" stroke-width="3" stroke-linecap="round">
    <circle cx="32" cy="32" r="20"/>
    <circle cx="32" cy="32" r="2" fill="#ff3b3b" stroke="none"/>
    <path d="M32 4V20M32 44V60M4 32H20M44 32H60"/>
</svg>`;
const AIM_MS = 550;        // crosshair zooms in, message trembles
const CRUMBLE_MS = 380;    // after the shot, before it falls apart
const PELLETS = 8;
const SPREAD = 38;         // px radius of the pellet spread
const CHUNK_SIZE = 46;     // roughly how big each crumbled piece is

const random = (min: number, max: number) => min + Math.random() * (max - min);

function shoot(body: Body, aimX: number, aimY: number) {
    body.frozen = true;
    body.vx = body.vy = body.av = 0;

    const crosshair = document.createElement("div");
    crosshair.className = "vc-gravity-crosshair";
    crosshair.innerHTML = CROSSHAIR_SVG;
    Object.assign(crosshair.style, { left: `${aimX}px`, top: `${aimY}px` });
    overlay!.appendChild(crosshair);
    crosshair.animate([
        { transform: "translate(-50%, -50%) scale(2.4) rotate(90deg)", opacity: 0 },
        { transform: "translate(-50%, -50%) scale(1) rotate(0deg)", opacity: 1 },
    ], { duration: AIM_MS * 0.8, easing: "cubic-bezier(.2,.8,.3,1)", fill: "forwards" });

    setTimeout(() => {
        crosshair.remove();
        if (!bodies.includes(body)) return;
        fire(body, aimX, aimY);
        setTimeout(() => bodies.includes(body) && crumble(body, aimX, aimY), CRUMBLE_MS);
    }, AIM_MS);
}

function fire(body: Body, aimX: number, aimY: number) {
    muzzleFlash(0.55);

    const bang = document.createElement("div");
    bang.className = "vc-gravity-bang";
    bang.textContent = "BANG!";
    Object.assign(bang.style, { left: `${aimX}px`, top: `${aimY - 30}px` });
    overlay!.appendChild(bang);
    bang.animate([
        { transform: "translate(-50%, -50%) scale(0.4) rotate(-12deg)", opacity: 1 },
        { transform: "translate(-50%, -50%) scale(1.25) rotate(-6deg)", opacity: 1, offset: 0.4 },
        { transform: "translate(-50%, -90%) scale(1.1) rotate(-6deg)", opacity: 0 },
    ], { duration: 650, easing: "ease-out", fill: "forwards" }).finished.then(() => bang.remove(), () => { });

    shakeChat(2.2);

    // Pellet holes, spread around the aim point but kept inside the message
    const localX = aimX - body.x, localY = aimY - body.y;
    for (let i = 0; i < PELLETS; i++) {
        const angle = Math.random() * Math.PI * 2;
        const dist = Math.sqrt(Math.random()) * SPREAD; // sqrt = even spread over the circle, not clumped in the middle
        addHole(body, localX + Math.cos(angle) * dist, localY + Math.sin(angle) * dist, random(9, 15));
    }

    // Recoil jolt
    body.angle = random(-7, 7);
}

function muzzleFlash(strength: number) {
    const flash = document.createElement("div");
    flash.className = "vc-gravity-flash";
    overlay!.appendChild(flash);
    flash.animate([{ opacity: strength }, { opacity: 0 }], { duration: 140, fill: "forwards" })
        .finished.then(() => flash.remove(), () => { });
}

// A bullet hole at a point inside the message (kept within its edges)
function addHole(body: Body, x: number, y: number, size: number) {
    const hole = document.createElement("div");
    hole.className = "vc-gravity-hole";
    Object.assign(hole.style, {
        width: `${size}px`,
        height: `${size}px`,
        left: `${Math.min(Math.max(x, size / 2), body.w - size / 2) - size / 2}px`,
        top: `${Math.min(Math.max(y, size / 2), body.h - size / 2) - size / 2}px`,
    });
    body.el.appendChild(hole);
}

/* ---------- western showdown ---------- */

const MARK_MS = 2600;      // real time you get to place marks
const MAX_MARKS = 6;
const SHOT_GAP = 130;      // ms between shots in the volley
const SLOW_MO = 0.25;      // physics speed while marking

const MARK_SVG = `<svg viewBox="0 0 24 24" width="22" height="22" stroke="#e03131" stroke-width="4" stroke-linecap="round">
    <path d="M5 5L19 19M19 5L5 19"/>
</svg>`;

interface Showdown {
    body: Body;
    marks: { x: number; y: number; el: HTMLElement; }[];
    firing: boolean;
    timer: ReturnType<typeof setTimeout>;
    extras: HTMLElement[];  // vignette + timer bar
}

let showdown: Showdown | null = null;
let timeScale = 1;

function startShowdown(body: Body, aimX: number, aimY: number) {
    body.frozen = true;
    body.vx = body.vy = body.av = 0;
    timeScale = SLOW_MO;
    document.body.classList.add("vc-gravity-showdown");

    const vignette = document.createElement("div");
    vignette.className = "vc-gravity-vignette";
    vignette.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 250, fill: "forwards" });
    // Heartbeat: two quick thumps, then a pause
    const pulse = document.createElement("div");
    pulse.className = "vc-gravity-vignette vc-gravity-heartbeat";
    pulse.animate([
        { opacity: 0 }, { opacity: 0.9, offset: 0.1 }, { opacity: 0.2, offset: 0.25 },
        { opacity: 0.7, offset: 0.35 }, { opacity: 0, offset: 0.6 }, { opacity: 0 },
    ], { duration: 950, iterations: Infinity });

    const bar = document.createElement("div");
    bar.className = "vc-gravity-timer";
    bar.animate([{ transform: "scaleX(1)" }, { transform: "scaleX(0)" }], { duration: MARK_MS, fill: "forwards" });

    // Insert behind the messages so the target stays in full color on top
    overlay!.prepend(vignette, pulse);
    overlay!.appendChild(bar);

    showdown = {
        body,
        marks: [],
        firing: false,
        timer: setTimeout(fireShowdown, MARK_MS),
        extras: [vignette, pulse, bar],
    };
    addMark(aimX - body.x, aimY - body.y);
}

function addMark(x: number, y: number) {
    const sd = showdown;
    if (!sd || sd.firing || sd.marks.length >= MAX_MARKS) return;

    const el = document.createElement("div");
    el.className = "vc-gravity-mark";
    el.innerHTML = MARK_SVG;
    Object.assign(el.style, { left: `${x}px`, top: `${y}px` });
    sd.body.el.appendChild(el);
    el.animate([
        { transform: "translate(-50%, -50%) scale(2) rotate(-30deg)", opacity: 0 },
        { transform: "translate(-50%, -50%) scale(1) rotate(0deg)", opacity: 1 },
    ], { duration: 160, easing: "ease-out", fill: "forwards" });

    sd.marks.push({ x, y, el });

    if (sd.marks.length === MAX_MARKS) {
        clearTimeout(sd.timer);
        sd.timer = setTimeout(fireShowdown, 180);
    }
}

function fireShowdown() {
    const sd = showdown;
    if (!sd || sd.firing) return;
    sd.firing = true;
    sd.extras.find(e => e.classList.contains("vc-gravity-timer"))?.remove();

    const { body, marks } = sd;
    marks.forEach((mark, i) => setTimeout(() => {
        if (!bodies.includes(body)) return;
        mark.el.remove();
        addHole(body, mark.x, mark.y, random(11, 16));
        muzzleFlash(0.35);
        shakeChat(1.3);
        body.angle = random(-6, 6);
    }, i * SHOT_GAP));

    setTimeout(() => {
        if (bodies.includes(body)) {
            const avgX = marks.reduce((sum, m) => sum + m.x, 0) / marks.length;
            const avgY = marks.reduce((sum, m) => sum + m.y, 0) / marks.length;
            crumble(body, body.x + avgX, body.y + avgY);
        }
        endShowdown();
    }, marks.length * SHOT_GAP + 250);
}

function endShowdown() {
    if (!showdown) return;
    clearTimeout(showdown.timer);
    for (const el of showdown.extras) {
        el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 350, fill: "forwards" })
            .finished.then(() => el.remove(), () => { });
    }
    showdown = null;
    timeScale = 1;
    document.body.classList.remove("vc-gravity-showdown");
}

// Pieces of the message's outline with slightly ragged corners, so it looks broken rather than sliced
const jagged = (w: number, h: number) => {
    const j = () => random(0, 4);
    return `polygon(${j()}px ${j()}px, ${w - j()}px ${j()}px, ${w - j()}px ${h - j()}px, ${j()}px ${h - j()}px)`;
};

function crumble(body: Body, aimX: number, aimY: number) {
    const cols = Math.max(2, Math.round(body.w / CHUNK_SIZE));
    const rows = Math.max(1, Math.round(body.h / CHUNK_SIZE));
    const pw = body.w / cols, ph = body.h / rows;

    body.el.remove();
    bodies.splice(bodies.indexOf(body), 1);

    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const px = c * pw, py = r * ph;

            // Each chunk is a window onto a copy of the shot message (bullet holes included)
            const inner = body.el.cloneNode(true) as HTMLElement;
            inner.classList.add("vc-gravity-chunk-inner");
            Object.assign(inner.style, { transform: "none", left: `${-px}px`, top: `${-py}px` });

            // The clip lives on an inner layer so the chunk's drop shadow follows the broken edge
            const clip = document.createElement("div");
            clip.className = "vc-gravity-chunk-clip";
            clip.style.clipPath = jagged(pw, ph);
            clip.appendChild(inner);

            const chunk = document.createElement("div");
            chunk.className = "vc-gravity-body vc-gravity-chunk";
            Object.assign(chunk.style, { width: `${pw}px`, height: `${ph}px` });
            chunk.appendChild(clip);

            // Blast pieces away from where the shot hit, with an upward pop
            const cx = body.x + px + pw / 2, cy = body.y + py + ph / 2;
            const dx = cx - aimX, dy = cy - aimY;
            const len = Math.hypot(dx, dy) || 1;
            const force = random(250, 650);

            addBody({
                el: chunk,
                x: body.x + px,
                y: body.y + py,
                w: pw,
                h: ph,
                vx: dx / len * force,
                vy: dy / len * force - random(250, 500),
                angle: body.angle,
                av: random(-420, 420),
                supported: false,
                frozen: false,
                flying: false,
            });
        }
    }
}

function disable() {
    endShowdown();
    cancelAnimationFrame(rafId);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    overlay?.remove();
    overlay = null;
    bodies = [];
    held = null;
    mode = null;
    hiddenIds.clear();
    hiddenStyle?.remove();
    hiddenStyle = null;
    document.body.classList.remove("vc-gravity-all");
}

const isActive = () => overlay !== null;

/* ---------- simulation ---------- */

function render(b: Body) {
    b.el.style.transform = `translate(${b.x}px, ${b.y}px) rotate(${b.angle}deg)`;
}

// Bodies that the physics can't move: the one you're dragging, or one waiting to be kicked
const isFixed = (b: Body) => b === held || b.frozen;

function overlaps(a: Body, b: Body) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function resolveCollision(a: Body, b: Body) {
    const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);

    if (overlapY <= overlapX) {
        // Vertical hit: the higher one lands on top of the lower one
        const [top, bottom] = a.y + a.h / 2 < b.y + b.h / 2 ? [a, b] : [b, a];

        if (!isFixed(top)) top.y -= overlapY;
        else if (!isFixed(bottom)) bottom.y += overlapY;

        // Landing on another message absorbs the impact (only the floor bounces).
        // Bouncing off moving messages would add up through a tall stack and launch the top one.
        if (!isFixed(top) && top.vy > bottom.vy) {
            top.vy = bottom.vy;
            top.vx *= FRICTION;
            top.av *= 0.5;
        }
        top.supported = true;
    } else {
        // Side hit: push apart and trade some sideways speed
        const [left, right] = a.x < b.x ? [a, b] : [b, a];
        if (!isFixed(left)) left.x -= overlapX / 2;
        if (!isFixed(right)) right.x += overlapX / 2;

        const lv = left.vx, rv = right.vx;
        if (lv > rv) {
            left.vx = rv * 0.6;
            right.vx = lv * 0.6;
        }
    }
}

function tick(now: number) {
    const dt = Math.min((now - lastTime) / 1000, 1 / 30) * timeScale; // clamp so a lag spike doesn't teleport things
    lastTime = now;

    for (const b of bodies) {
        b.supported = false;
        if (b.frozen) {
            b.angle = Math.sin(now / 25) * 1.5; // nervous trembling before the kick
            continue;
        }
        if (b === held) continue;

        b.vy += GRAVITY * dt;
        // Safety cap so a wild throw can't tunnel through everything
        b.vx = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, b.vx));
        b.vy = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, b.vy));
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        b.angle += b.av * dt;
    }

    for (let step = 0; step < SOLVER_STEPS; step++) {
        for (let i = 0; i < bodies.length; i++) {
            for (let j = i + 1; j < bodies.length; j++) {
                if (bodies[i].flying || bodies[j].flying) continue;
                if (overlaps(bodies[i], bodies[j])) resolveCollision(bodies[i], bodies[j]);
            }
        }

        for (const b of bodies) {
            if (b.flying) continue;
            // Floor
            if (b.y + b.h > bounds.h) {
                b.y = bounds.h - b.h;
                if (b.vy > 0) {
                    b.vy = Math.abs(b.vy) < 60 ? 0 : -b.vy * BOUNCE;
                    b.vx *= FRICTION;
                    b.av *= 0.6;
                }
                b.supported = true;
            }
            // Walls
            if (b.x < 0) {
                b.x = 0;
                b.vx = Math.abs(b.vx) * 0.5;
            } else if (b.x + b.w > bounds.w) {
                b.x = bounds.w - b.w;
                b.vx = -Math.abs(b.vx) * 0.5;
            }
        }
    }

    // Kicked messages are gone once they leave the window
    const area = overlay!.getBoundingClientRect();
    bodies = bodies.filter(b => {
        const gone = b.flying && (area.left + b.x > window.innerWidth || area.top + b.y > window.innerHeight);
        if (gone) b.el.remove();
        return !gone;
    });

    for (const b of bodies) {
        if (b.supported && !isFixed(b)) {
            // Resting on something: drop leftover downward speed so stacks don't shimmer
            if (b.vy > 0) b.vy = 0;
            // Settle: stop spinning and lean back toward a slight tilt
            b.av *= 0.8;
            b.angle *= 0.94;
            b.vx *= 0.96;
        }
        render(b);
    }

    rafId = requestAnimationFrame(tick);
}

/* ---------- grab & throw ---------- */

function toLocal(e: PointerEvent) {
    const r = overlay!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function onPointerDown(e: PointerEvent) {
    const target = (e.target as HTMLElement).closest(".vc-gravity-body");
    const body = bodies.find(b => b.el === target);
    if (!body) return;

    // During a showdown, clicking the target paints a mark instead of grabbing it
    if (showdown && body === showdown.body) {
        e.preventDefault();
        const p = toLocal(e);
        addMark(p.x - body.x, p.y - body.y);
        return;
    }
    if (body.frozen) return;

    e.preventDefault();
    held = body;
    const p = toLocal(e);
    grabOffset = { x: p.x - body.x, y: p.y - body.y };
    pointerHistory = [{ ...p, t: performance.now() }];
    body.vx = body.vy = body.av = 0;
    body.el.classList.add("vc-gravity-held");

    // Bring to front
    overlay!.appendChild(body.el);

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
}

function onPointerMove(e: PointerEvent) {
    if (!held) return;
    const p = toLocal(e);
    held.x = p.x - grabOffset.x;
    held.y = p.y - grabOffset.y;

    pointerHistory.push({ ...p, t: performance.now() });
    if (pointerHistory.length > 6) pointerHistory.shift();
}

function onPointerUp() {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    if (!held) return;

    // Throw with the speed the mouse was moving at
    const first = pointerHistory[0];
    const last = pointerHistory[pointerHistory.length - 1];
    const seconds = Math.max((last.t - first.t) / 1000, 0.016);
    held.vx = (last.x - first.x) / seconds;
    held.vy = (last.y - first.y) / seconds;
    held.av = held.vx * 0.15; // spin in the throw direction

    held.el.classList.remove("vc-gravity-held");
    held = null;
}

/* ---------- controls ---------- */

function onKeyDown(e: KeyboardEvent) {
    if (e.ctrlKey && e.shiftKey && !e.altKey && e.code === "KeyG") {
        e.preventDefault();
        e.stopPropagation();
        // From single-message mode, drop the rest too; from full mode, restore
        if (mode === "all") disable();
        else dropAll();
    } else if (e.key === "Escape" && isActive()) {
        e.preventDefault();
        e.stopPropagation();
        disable();
    }
}

// Ctrl+Shift+click a message to drop just that one
function onClick(e: MouseEvent) {
    if (!e.ctrlKey || !e.shiftKey || e.altKey) return;

    const target = e.target as HTMLElement;
    // Leave spoilers alone so RevealAllSpoilers' Ctrl+Shift+click still works
    if (target.closest('[class*="spoilerContent"]')) return;

    const li = target.closest<HTMLElement>('li[id^="chat-messages-"]');
    if (!li || !getWrapper()?.contains(li)) return;

    e.preventDefault();
    e.stopPropagation();
    document.getSelection()?.removeAllRanges(); // Shift+click would otherwise select text
    dropOne(li, settings.store.clickAction, e.clientX, e.clientY);
}

export default definePlugin({
    name: "GravityMode",
    description: "Ctrl+Shift+click a message to make it fall, get kicked out or get shot, or Ctrl+Shift+G to drop every message. Drag to throw them; Esc to restore",
    authors: [{ name: "pirate_6581", id: 474590209527382056n }],
    settings,

    // The overlay is a snapshot of the current chat, so drop it if the view changes underneath
    flux: {
        CHANNEL_SELECT() {
            if (isActive()) disable();
        },
    },

    start() {
        document.addEventListener("keydown", onKeyDown, true);
        document.addEventListener("click", onClick, true);
        window.addEventListener("resize", disable);
    },

    stop() {
        document.removeEventListener("keydown", onKeyDown, true);
        document.removeEventListener("click", onClick, true);
        window.removeEventListener("resize", disable);
        disable();
    },
});
