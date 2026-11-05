/**
 * Does a flex container's content fit, process badge included? The badge stays
 * in the page while hidden (`position: absolute; visibility: hidden`), so it can
 * still be measured; its CSS `min-width` holds the worst-case width, which keeps
 * changing digits from flipping the answer.
 *
 * Children are counted by their rendered width, with the container's gap between
 * them. Two markers change that:
 * - `data-fit-grow`: a spacer; it takes up what is left, so only its gap counts.
 * - `data-fit-skip`: not counted at all (the icon that stands in for the badge).
 */
export function contentFits(container: Element): boolean {
  const style = getComputedStyle(container);
  const inner =
    container.getBoundingClientRect().width -
    (parseFloat(style.paddingLeft) || 0) -
    (parseFloat(style.paddingRight) || 0);
  const items = [...container.children].filter((child) => !child.hasAttribute("data-fit-skip"));
  const gaps = (parseFloat(style.columnGap) || 0) * Math.max(items.length - 1, 0);
  const content = items.reduce(
    (total, item) =>
      total + (item.hasAttribute("data-fit-grow") ? 0 : item.getBoundingClientRect().width),
    0
  );
  return content + gaps <= inner;
}

/**
 * Svelte action: reports whether the content fits, on mount and whenever the
 * container resizes or its content changes. Attribute changes are not watched:
 * showing or hiding the badge changes none of the widths counted.
 */
export function watchFit(
  node: HTMLElement,
  onChange: (fits: boolean) => void
): { update: (next: (fits: boolean) => void) => void; destroy: () => void } {
  let report = onChange;
  let last: boolean | null = null;
  const check = (): void => {
    const fits = contentFits(node);
    if (fits === last) return;
    last = fits;
    report(fits);
  };

  const resizes = new ResizeObserver(check);
  resizes.observe(node);
  const mutations = new MutationObserver(check);
  mutations.observe(node, { childList: true, characterData: true, subtree: true });
  check();

  return {
    update(next) {
      report = next;
    },
    destroy() {
      resizes.disconnect();
      mutations.disconnect();
    },
  };
}
