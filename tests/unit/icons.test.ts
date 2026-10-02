import { describe, expect, it } from "vitest";
import { ICON_NAMES, ICON_STYLES } from "@/components/icon-names";
import icons from "@/generated/iconsax-icons.json";

type Node = [string, Record<string, string>, Node[]?];
const walk = (nodes: Node[]): Node[] => nodes.flatMap((n) => [n, ...walk(n[2] ?? [])]);

describe("subset ikon iconsax", () => {
  const data = icons as unknown as Record<string, Record<string, { viewBox: string; nodes: Node[] }>>;

  it("berisi tepat semua ICON_NAMES × ICON_STYLES (jalankan `npm run icons` bila gagal)", () => {
    expect(Object.keys(data).sort()).toEqual([...ICON_NAMES].sort());
    for (const name of ICON_NAMES) {
      for (const style of ICON_STYLES) {
        expect(data[name]?.[style]?.nodes.length, `${name}/${style}`).toBeGreaterThan(0);
      }
    }
  });

  it("tanpa atribut style/id/href dan tanpa warna putih tetap (CSP + tema)", () => {
    for (const styles of Object.values(data)) {
      for (const { nodes } of Object.values(styles)) {
        for (const [, attrs] of walk(nodes)) {
          for (const [k, v] of Object.entries(attrs)) {
            expect(["style", "id", "href", "xlinkHref"]).not.toContain(k);
            expect(v).not.toBe("white");
          }
        }
      }
    }
  });
});
