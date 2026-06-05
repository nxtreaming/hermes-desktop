import { existsSync, readFileSync, rmSync } from "fs";
import { extname } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: class {},
  dialog: {
    showSaveDialog: vi.fn(),
  },
}));

import {
  cleanupTempMediaFiles,
  materializeDataUrlToTemp,
} from "../src/main/media";

describe("materializeDataUrlToTemp", () => {
  afterEach(() => {
    cleanupTempMediaFiles();
  });

  it("writes a data URL to a temporary image file that can be opened", () => {
    const path = materializeDataUrlToTemp(
      "data:image/png;base64,SGVybWVz",
      "prompt-image",
    );

    expect(path).toBeTruthy();
    expect(extname(path || "")).toBe(".png");
    expect(existsSync(path || "")).toBe(true);
    expect(readFileSync(path || "", "utf-8")).toBe("Hermes");

    if (path) rmSync(path, { force: true });
  });

  it("reuses the same temporary file for the same image data", () => {
    const first = materializeDataUrlToTemp(
      "data:image/png;base64,SGVybWVz",
      "prompt-image",
    );
    const second = materializeDataUrlToTemp(
      "data:image/png;base64,SGVybWVz",
      "prompt-image",
    );

    expect(first).toBeTruthy();
    expect(second).toBe(first);
  });

  it("cleans up temporary media files", () => {
    const path = materializeDataUrlToTemp(
      "data:image/png;base64,SGVybWVz",
      "prompt-image",
    );

    expect(path).toBeTruthy();
    expect(existsSync(path || "")).toBe(true);

    cleanupTempMediaFiles();

    expect(existsSync(path || "")).toBe(false);
  });
});
