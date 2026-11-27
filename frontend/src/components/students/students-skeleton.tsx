const bone = "animate-pulse rounded-sm bg-slate-200 motion-reduce:animate-none";

/** Tiles, the two panels and roster rows while the roster loads (the header stays interactive). */
export function StudentsSkeletonBody() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading students">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-28 space-y-2 rounded-md border border-slate-200 bg-white px-4 py-3">
            <div className={`h-3 w-20 ${bone}`} />
            <div className={`h-7 w-12 ${bone}`} />
            <div className={`h-3 w-full ${bone}`} />
          </div>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-12">
        <div className="h-64 rounded-md border border-slate-200 bg-white lg:col-span-7" />
        <div className="h-64 rounded-md border border-slate-200 bg-white lg:col-span-5" />
      </div>
      <div className="divide-y divide-slate-100 rounded-md border border-slate-200 bg-white">
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
          <div key={i} className="flex gap-4 px-3 py-3.5">
            <div className={`h-4 w-40 ${bone}`} />
            <div className={`h-4 flex-1 ${bone}`} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Static shell for /students while the URL-driven view hydrates: header, 4 tiles, 2 panels, 8 rows. */
export function StudentsSkeleton() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <div className={`h-7 w-40 ${bone}`} />
        <div className={`h-4 w-80 max-w-full ${bone}`} />
      </div>
      <div className="h-14 rounded-md border border-slate-200 bg-white" />
      <StudentsSkeletonBody />
    </div>
  );
}
