/**
 * Ikon Iconsax (MIT) sebagai SVG inline yang dirender server — tanpa JS klien, tanpa atribut `style`
 * (CSP control-plane) dan tanpa `dangerouslySetInnerHTML`. Data: src/generated/iconsax-icons.json (`npm run icons`).
 * Warna mengikuti `currentColor`; ukuran lewat className (default `size-5`).
 */
import { createElement, type ReactNode } from "react";
import icons from "@/generated/iconsax-icons.json";
import type { IconName, IconStyle } from "./icon-names";

export type { IconName, IconStyle } from "./icon-names";

type IconNode = [string, Record<string, string>, IconNode[]?];
type IconData = { viewBox: string; nodes: IconNode[] };
const DATA = icons as unknown as Record<IconName, Record<IconStyle, IconData>>;

function render(nodes: IconNode[]): ReactNode[] {
  return nodes.map(([tag, attrs, children], i) => createElement(tag, { key: i, ...attrs }, children ? render(children) : null));
}

export function Icon(props: { name: IconName; variant?: IconStyle; className?: string; label?: string }) {
  const icon = DATA[props.name][props.variant ?? "linear"];
  return (
    <svg viewBox={icon.viewBox} fill="none" xmlns="http://www.w3.org/2000/svg"
      className={`shrink-0 ${props.className ?? "size-5"}`}
      role={props.label ? "img" : undefined} aria-label={props.label} aria-hidden={props.label ? undefined : true}>
      {render(icon.nodes)}
    </svg>
  );
}
