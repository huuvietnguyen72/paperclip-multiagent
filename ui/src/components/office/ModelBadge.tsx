import { AdapterMark } from "@/components/AdapterMark";
import type { ModelBadge as ModelBadgeData } from "@/lib/office/model-badge";
import { strings as fallbackStrings } from "@/lib/model-fallback/strings";
import { cn } from "@/lib/utils";

/** Logo + name of the model an agent currently uses. */
export function ModelBadge({ badge, size = "sm", className, isFallback = false, unknown = false }: { badge: ModelBadgeData; size?: "sm" | "xs"; className?: string; isFallback?: boolean; /** The in-use connection could not be loaded. */ unknown?: boolean }) {
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
      {isFallback ? (
        <span data-testid="model-badge-fallback-tag" className="shrink-0 rounded-full bg-muted px-1 text-foreground">
          {fallbackStrings.activeFallbackTag}
        </span>
      ) : null}
      {!isFallback && unknown ? (
        <span
          data-testid="model-badge-unknown"
          className="shrink-0 rounded-full bg-muted px-1 text-muted-foreground"
          title={fallbackStrings.activeUnknown}
          aria-label={fallbackStrings.activeUnknown}
        >
          {fallbackStrings.activeUnknownMark}
        </span>
      ) : null}
    </span>
  );
}
