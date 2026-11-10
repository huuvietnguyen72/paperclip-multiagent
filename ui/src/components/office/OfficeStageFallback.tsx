import { Building2 } from "lucide-react";

/** Shown in place of the 3D office when WebGL is unavailable or the scene fails to start. */
export function OfficeStageFallback({ message }: { message: string }) {
  return (
    <div className="flex h-full min-h-64 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
      <Building2 className="size-8" />
      <p>{message}</p>
    </div>
  );
}
