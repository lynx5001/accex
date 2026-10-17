/**
 * jsdom lacks a few browser APIs the UI relies on; provide minimal stand-ins.
 */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

const proto = HTMLDialogElement.prototype;
proto.showModal ??= function (this: HTMLDialogElement) {
  this.setAttribute("open", "");
};
proto.close ??= function (this: HTMLDialogElement) {
  this.removeAttribute("open");
};
Element.prototype.scrollIntoView ??= function () {};

// Tauri's mocks need a `crypto.getRandomValues`, present in Node 20+.
