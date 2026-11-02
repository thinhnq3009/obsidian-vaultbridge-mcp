import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);
const read = (file: string) => fs.readFile(new URL(file, root), "utf8");

describe("FE-001 locked source contract", () => {
  it("preserves the exact original 1672×941 PNG", async () => {
    const png = await fs.readFile(new URL("web/public/assets/obsidian-crystal-login-bg.png", root));
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1672, 941]);
    expect(createHash("sha256").update(png).digest("hex")).toBe("09b3439af1755af8dc41a3c795d23368f5dc85af18343bc2b6e3fb5cf50615d4");
  });
  it("uses the supplied transparent brand master instead of a generic icon", async () => {
    const mark = await fs.readFile(new URL("web/public/assets/vaultbridge-crystal-mark.png", root));
    expect([mark.readUInt32BE(16), mark.readUInt32BE(20)]).toEqual([1254, 1254]);
    expect(createHash("sha256").update(mark).digest("hex")).toBe("a2efdebc474b82c64bae07920f7f4f79933486fe4bf94fdeda0bc055e2f161e2");
    expect(await read("web/src/components/Brand.tsx")).toContain("assets/vaultbridge-crystal-mark.png");
  });
  it("locks every FE-UI-001 token to one canonical source", async () => {
    const css = await read("web/src/styles/tokens.css");
    const tokens: Record<string, string> = {
      bg: "#060A13", "bg-raised": "#0C1527", surface: "#111D31", "surface-high": "#17253B",
      glass: "rgba(10,18,33,.82)", border: "#2A3D56", "border-glow": "rgba(70,209,237,.38)",
      primary: "#36D9EA", "primary-hover": "#72ECF7", accent: "#A078F5", blue: "#427CCB",
      text: "#EEF6FF", muted: "#ACBED4", "on-primary": "#06141E",
      success: "#50D4AD", warning: "#FFD28D", danger: "#FF839B",
      "radius-field": "12px", "radius-card": "20px", "control-height": "46px",
      "shadow-card": "0 26px 70px rgba(0,0,0,.5)",
    };
    for (const [name, value] of Object.entries(tokens)) expect(css).toContain(`--vb-${name}: ${value};`);
    const styles = await read("web/src/styles/index.css");
    expect(styles).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/iu);
    expect(styles).toContain("prefers-reduced-motion");
  });
});
