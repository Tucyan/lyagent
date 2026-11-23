// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatComposer } from "../web/src/components/ChatComposer.js";

let root: Root;
let container: HTMLDivElement;

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container?.remove();
  vi.unstubAllGlobals();
});

describe("ChatComposer IME and keyboard behavior", () => {
  it("blocks Enter during IME composition and allows Shift+Enter newline without sending", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const onSend = vi.fn();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root.render(createElement(ChatComposer, {
        value: "什么是反向传播",
        onChange: () => undefined,
        onSend,
        onStop: () => undefined,
        allowWebSearch: true,
        onAllowWebSearchChange: () => undefined,
        disabled: false,
        placeholder: "请输入问题",
        streaming: false,
      }));
    });

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true }));
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }));
    });
    expect(onSend).toHaveBeenCalledTimes(0);

    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(onSend).toHaveBeenCalledTimes(1);
  });
});
