import { AdapterMark } from "@/components/AdapterMark";
import type { ModelBadge as ModelBadgeData } from "@/lib/office/model-badge";
import { cn } from "@/lib/utils";

/** Logo + name of the model an agent currently uses. */
export function ModelBadge({ badge, size = "sm", className }: { badge: ModelBadgeData; size?: "sm" | "xs"; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1 text-muted-foreground",
        size === "xs" ? "text-(length:--text-micro)" : "text-xs",
        className,
      )}
      title={badge.label}
    >
      <AdapterMark type={badge.markType} className={size === "xs" ? "size-3" : "size-3.5"} />
      <span className="truncate">{badge.label}</span>
    </span>
  );
}
