/** Static shell for /students while the URL-driven view hydrates. */
export function StudentsSkeleton() {
  const bone = "animate-pulse rounded-sm bg-slate-200 motion-reduce:animate-none";
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading students">
      <div className="space-y-2">
        <div className={`h-7 w-40 ${bone}`} />
        <div className={`h-4 w-96 max-w-full ${bone}`} />
      </div>
      <div className="h-14 rounded-md border border-slate-200 bg-white" />
      <div className="h-10 border-b border-slate-200" />
      <div className="divide-y divide-slate-100 rounded-md border border-slate-200 bg-white">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="flex gap-4 px-3 py-3">
            <div className={`h-4 w-40 ${bone}`} />
            <div className={`h-4 flex-1 ${bone}`} />
          </div>
        ))}
      </div>
    </div>
  );
}
