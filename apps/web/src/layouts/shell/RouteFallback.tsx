/**
 * shell/RouteFallback.tsx — what a lazily-loaded page shows while its chunk
 * arrives. A skeleton in the shape of a page, never a spinner: the layout does
 * not jump when the real content lands.
 */
import { Skeleton } from "../../ui";

export function RouteFallback() {
  return (
    <div className="animate-fade-in" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading page…</span>
      <div className="space-y-2">
        <Skeleton className="h-6 w-52 rounded-md" />
        <Skeleton className="h-4 w-80 rounded" />
      </div>
      <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((tile) => (
          <Skeleton key={tile} className="h-24 rounded-lg" />
        ))}
      </div>
      <div className="mt-6 grid gap-3 xl:grid-cols-3">
        <Skeleton className="h-72 rounded-lg xl:col-span-2" />
        <Skeleton className="h-72 rounded-lg" />
      </div>
    </div>
  );
}

export default RouteFallback;
