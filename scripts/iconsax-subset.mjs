#!/usr/bin/env node
/**
 * Ekstrak SUBSET ikon GRATIS Iconsax (paket `iconsax`, MIT) → src/generated/iconsax-icons.json.
 *
 * Kenapa bukan web component <iconsax-icon>: control-plane tanpa JS klien per ikon, dan ESLint melarang
 * `dangerouslySetInnerHTML`. SVG diurai menjadi pohon elemen `[tag, attrs, children]` yang dirender <Icon> sebagai JSX:
 * - pembungkus `<g clip-path>` + `<defs>` dibuang (clip = kotak 24×24 penuh, tanpa efek), sehingga tidak ada id
 *   ganda saat ikon yang sama muncul berkali-kali;
 * - warna `white` → `currentColor` (mengikuti warna teks / token tema);
 * - nama atribut kebab-case → camelCase React (stroke-width → strokeWidth).
 *
 * Sumber daftar: ICON_NAMES & ICON_STYLES di src/components/icon-names.ts. Jalankan: `npm run icons`.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "src/components/icon-names.ts"), "utf8");

function listConst(name) {
  const m = src.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const`));
  if (!m) throw new Error(`${name} tidak ditemukan di icon-names.ts`);
  return [...m[1].matchAll(/"([a-z0-9-]+)"/g)].map((x) => x[1]);
}

const ALLOWED_TAGS = new Set(["path", "circle", "rect", "line", "ellipse", "polyline", "polygon", "g"]);
const ALLOWED_ATTRS = new Set([
  "d", "cx", "cy", "r", "rx", "ry", "x", "y", "x1", "y1", "x2", "y2", "width", "height", "points", "transform",
  "opacity", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit",
  "fill-rule", "clip-rule",
]);
const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

/** Urai SVG iconsax (XML sederhana tanpa teks) → `{ viewBox, nodes }`, nodes = pohon `[tag, attrs, children]`. */
function parse(svg) {
  const stack = [{ tag: "root", attrs: {}, children: [] }];
  for (const [, close, tag, rawAttrs, selfClose] of svg.matchAll(/<(\/?)([a-zA-Z]+)([^>]*?)(\/?)>/g)) {
    if (close) {
      const node = stack.pop();
      if (node.tag !== tag) throw new Error(`tag tidak seimbang: ${node.tag} vs ${tag}`);
      stack.at(-1).children.push(node);
      continue;
    }
    const attrs = Object.fromEntries([...rawAttrs.matchAll(/([a-zA-Z-:]+)="([^"]*)"/g)].map((a) => [a[1], a[2]]));
    const node = { tag, attrs, children: [] };
    if (selfClose) stack.at(-1).children.push(node);
    else stack.push(node);
  }
  const svgNode = stack[0].children[0];
  if (stack.length !== 1 || svgNode?.tag !== "svg" || !/^0 0 \d+(\.\d+)? \d+(\.\d+)?$/.test(svgNode.attrs.viewBox ?? "")) {
    throw new Error(`struktur SVG tidak dikenal (viewBox ${svgNode?.attrs.viewBox})`);
  }
  return { viewBox: svgNode.attrs.viewBox, nodes: svgNode.children.flatMap(convert) };
}

function convert(node) {
  if (node.tag === "defs") return [];
  // Pembungkus clip-path (kotak penuh) → lebur ke anak-anaknya.
  if (node.tag === "g" && Object.keys(node.attrs).every((k) => k === "clip-path")) return node.children.flatMap(convert);
  if (!ALLOWED_TAGS.has(node.tag)) throw new Error(`tag tidak diizinkan: ${node.tag}`);
  const attrs = {};
  for (const [k, v] of Object.entries(node.attrs)) {
    if (!ALLOWED_ATTRS.has(k)) throw new Error(`atribut tidak diizinkan: ${k}`);
    attrs[camel(k)] = v === "white" ? "currentColor" : v;
  }
  const children = node.children.flatMap(convert);
  return [children.length ? [node.tag, attrs, children] : [node.tag, attrs]];
}

const names = listConst("ICON_NAMES");
const styles = listConst("ICON_STYLES");
const pkg = join(root, "node_modules/iconsax/dist");
const manifest = JSON.parse(readFileSync(join(pkg, "manifest.json"), "utf8"));
const cache = new Map();
const out = {};

for (const name of names) {
  const entry = manifest[name];
  if (!entry) throw new Error(`Ikon "${name}" tidak ada di set gratis iconsax`);
  if (!cache.has(entry.category)) {
    cache.set(entry.category, JSON.parse(readFileSync(join(pkg, "data", `${entry.category}.json`), "utf8")));
  }
  const data = cache.get(entry.category)[name];
  out[name] = {};
  for (const style of styles) {
    if (!data?.[style]) throw new Error(`Ikon "${name}" tidak punya gaya "${style}"`);
    out[name][style] = parse(data[style]);
  }
}

const file = join(root, "src/generated/iconsax-icons.json");
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify(out) + "\n");
console.log(`iconsax subset: ${names.length} ikon × ${styles.length} gaya → src/generated/iconsax-icons.json`);
