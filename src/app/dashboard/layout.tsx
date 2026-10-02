import { MotionEnhancer } from "@/components/motion-enhancer";

/** Dashboard: tema Onyx terang/gelap mengikuti sistem (`.theme-auto`, globals.css) + hitung naik angka KPI. */
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="theme-auto min-h-screen bg-background text-foreground">
      {children}
      <MotionEnhancer />
    </div>
  );
}
