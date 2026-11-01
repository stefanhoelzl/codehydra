/**
 * The sidebar's motion: a row flying into its project's moon when it
 * hibernates, flying back out when it wakes, a slot growing for a new row,
 * and the cards' slide-in / slide-out.
 *
 * Rows live in two lists of a project card (the hibernated list and the awake
 * list), so a row that hibernates or wakes leaves one list and arrives in the
 * other. The Svelte `in:` / `out:` transitions below see both ends; the row's
 * position from before the update (captured by `capture`) is where its flying
 * copy starts. Every animation lands at once while motion is off (reduced
 * motion, the Find field being typed in).
 */

import type { TransitionConfig } from "svelte/transition";

const EASE = "cubic-bezier(.3,.7,.2,1)";

/** Smooth ease-out matching the CSS EASE curve closely enough for JS-driven frames. */
function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/** Folds that hide what is inside them. */
const CLOSED_FOLDS = ".cl:not(.open), .body-wrap:not(.open), .hib-group:not(.open)";

/** Whether an element is on screen: not inside a closed fold, and laid out. */
export function visible(el: Element | null): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  if (el.closest(CLOSED_FOLDS) !== null) return false;
  return el.getBoundingClientRect().height > 4;
}

/** A blue glow fading out: "here it is". */
export function highlight(el: Element): void {
  el.animate(
    [
      { boxShadow: "0 0 0 2px rgba(108,140,255,.9)" },
      { boxShadow: "0 0 0 2px rgba(108,140,255,0)" },
    ],
    { duration: 800, easing: "ease-out" }
  );
}

/** A fixed-position copy of a row, for flying it across the sidebar. */
function makeGhost(row: HTMLElement, rect: DOMRect): HTMLElement {
  const ghost = row.cloneNode(true) as HTMLElement;
  ghost.classList.remove("sel");
  ghost.classList.add("ghost");
  ghost.querySelector(".hover-acts")?.remove();
  Object.assign(ghost.style, {
    position: "fixed",
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    margin: "0",
    zIndex: "1000",
    pointerEvents: "none",
    transformOrigin: "center",
    visibility: "visible",
  });
  document.body.appendChild(ghost);
  return ghost;
}

/** CSS for a slot of `height` px at fraction `t` of its full size. */
function slotCss(t: number, height: number): string {
  return `height: ${t * height}px; overflow: hidden;`;
}

export interface RowMotionDeps {
  /** False while every change should land at once. */
  readonly enabled: () => boolean;
  /** The row with this key in the current snapshot, if any. */
  readonly row: (key: string) => { readonly hibernated: boolean } | undefined;
  /** Where a hibernating row of this project flies to (its moon, else its name). */
  readonly moonTarget: (projectId: string) => HTMLElement | null;
}

/** Positions and contents of the rows that were on screen before an update. */
interface Before {
  readonly rect: DOMRect;
  readonly el: HTMLElement;
  /** It sat in its project's hibernated list. */
  readonly inHibernatedList: boolean;
}

export interface RowMotion {
  /** Record every visible row's position; call before the DOM updates. */
  capture(root: HTMLElement | null): void;
  /** Remember the rows of the current snapshot (a later arrival is new or moved). */
  settle(keys: Iterable<string>): void;
  /** `out:` for a row leaving its list. */
  depart(node: HTMLElement, params: { key: string; projectId: string }): TransitionConfig;
  /** `in:` for a row arriving in a list. */
  arrive(node: HTMLElement, params: { key: string }): () => TransitionConfig;
}

export function createRowMotion(deps: RowMotionDeps): RowMotion {
  let before = new Map<string, Before>();
  const known = new Set<string>();

  function capture(root: HTMLElement | null): void {
    const next = new Map<string, Before>();
    if (root !== null && deps.enabled()) {
      for (const el of root.querySelectorAll<HTMLElement>(".ws[data-key]")) {
        const key = el.dataset.key;
        if (key === undefined || !visible(el)) continue;
        const inHibernatedList = el.closest(".hib-group") !== null;
        next.set(key, { rect: el.getBoundingClientRect(), el, inHibernatedList });
      }
    }
    before = next;
  }

  function settle(keys: Iterable<string>): void {
    known.clear();
    for (const key of keys) known.add(key);
  }

  /** Hibernate: the row lifts off and flies into the moon; the gap closes behind it. */
  function flyToMoon(node: HTMLElement, from: Before, projectId: string): TransitionConfig {
    const height = node.offsetHeight;
    const ghost = makeGhost(from.el, from.rect);
    node.style.visibility = "hidden";
    const target = deps.moonTarget(projectId);
    const to = target?.getBoundingClientRect();
    const dx = to ? to.left + to.width / 2 - (from.rect.left + from.rect.width / 2) : 0;
    const dy = to ? to.top + to.height / 2 - (from.rect.top + from.rect.height / 2) : 0;
    ghost.animate(
      [
        { transform: "translate(0,0) scale(1)", opacity: 1 },
        {
          transform: `translate(${dx * 0.08}px, ${dy * 0.08 + 4}px) scale(.96)`,
          opacity: 1,
          offset: 0.22,
        },
        { transform: `translate(${dx}px, ${dy}px) scale(.06)`, opacity: 0.15 },
      ],
      { duration: 560, easing: "cubic-bezier(.55,.05,.35,1)", fill: "forwards" }
    ).onfinish = () => {
      ghost.remove();
      deps
        .moonTarget(projectId)
        ?.animate(
          [{ transform: "scale(1)" }, { transform: "scale(1.5)" }, { transform: "scale(1)" }],
          { duration: 420, easing: "ease-out" }
        );
    };
    return { duration: 320, easing: easeOut, css: (t) => slotCss(t, height) };
  }

  /** Wake: a slot opens where the row belongs and its copy settles into it. */
  function flyIn(node: HTMLElement, from: Before): TransitionConfig {
    const ghost = makeGhost(from.el, from.rect);
    ghost.classList.add("active");
    node.style.visibility = "hidden";
    const height = node.offsetHeight;
    ghost.animate([{ transform: "scale(1)" }, { transform: "scale(1.04)" }], {
      duration: 200,
      easing: "ease-out",
      fill: "forwards",
    });
    setTimeout(() => {
      const to = node.getBoundingClientRect();
      ghost.animate(
        [
          { transform: "translate(0,0) scale(1.04)" },
          {
            transform: `translate(${to.left - from.rect.left}px, ${to.top - from.rect.top}px) scale(1)`,
          },
        ],
        { duration: 420, easing: EASE, fill: "forwards" }
      ).onfinish = () => {
        ghost.remove();
        node.style.visibility = "";
        const row = node.querySelector(".ws");
        if (row) highlight(row);
      };
    }, 300);
    return { duration: 300, easing: easeOut, css: (t) => slotCss(t, height) };
  }

  function depart(node: HTMLElement, params: { key: string; projectId: string }): TransitionConfig {
    const from = before.get(params.key);
    const now = deps.row(params.key);
    if (!deps.enabled() || from === undefined || now === undefined) return { duration: 0 };
    // Leaving the awake list for the hibernated one: fly into the moon. Leaving
    // the hibernated list (a wake) needs nothing here: its arrival flies.
    if (now.hibernated) return flyToMoon(node, from, params.projectId);
    return { duration: 0 };
  }

  function arrive(node: HTMLElement, params: { key: string }): () => TransitionConfig {
    // Deferred: the departure of the same row (from the other list) is seen first.
    return () => {
      const now = deps.row(params.key);
      if (!deps.enabled() || now === undefined || now.hibernated) return { duration: 0 };
      const from = before.get(params.key);
      const wasKnown = known.has(params.key);
      if (wasKnown && from !== undefined && from.inHibernatedList) {
        return flyIn(node, from);
      }
      if (!visible(node)) return { duration: 0 };
      const height = node.offsetHeight;
      if (wasKnown) {
        // Woke while its old place was out of sight: open the slot and point at it.
        setTimeout(() => {
          const row = node.querySelector(".ws");
          if (row) highlight(row);
        }, 300);
      }
      return { duration: 300, easing: easeOut, css: (t) => slotCss(t, height) };
    };
  }

  return { capture, settle, depart, arrive };
}

/** `in:` for a card: it slides up into place. */
export function noteIn(_node: Element, params: { enabled: boolean }): TransitionConfig {
  if (!params.enabled) return { duration: 0 };
  return {
    duration: 340,
    easing: (t) => 1 - Math.pow(1 - t, 3),
    css: (t) =>
      `opacity: ${t}; transform: translateY(${(1 - t) * 12}px) scale(${0.97 + 0.03 * t});`,
  };
}

/** `out:` for a card: it slides off to the right, then its slot closes. */
export function noteOut(node: HTMLElement, params: { enabled: boolean }): TransitionConfig {
  if (!params.enabled) return { duration: 0 };
  const height = node.offsetHeight;
  return {
    duration: 360,
    css: (t) => {
      const u = 1 - t;
      if (u < 0.5) {
        const k = u / 0.5;
        return `opacity: ${1 - k}; transform: translateX(${24 * k}px);`;
      }
      const k = (u - 0.5) / 0.5;
      return `opacity: 0; height: ${height * (1 - easeOut(k))}px; margin: 0; padding-top: 0; padding-bottom: 0; overflow: hidden;`;
    },
  };
}
