/** happy-dom has no layout: give the scroll area dimensions so the virtualizer renders rows. */
export function stubLayout(height = 800, width = 1200): void {
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => height });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => width });
}
