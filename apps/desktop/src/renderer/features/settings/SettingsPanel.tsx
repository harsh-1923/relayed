interface SettingsPanelItem {
  label: string;
  description: string;
  value: string;
}

export function SettingsPanel({
  title,
  description,
  items,
}: {
  title: string;
  description: string;
  items: readonly SettingsPanelItem[];
}) {
  return (
    <div className="mx-auto w-full max-w-2xl space-y-8">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>

      <section className="overflow-hidden rounded-xl border bg-card/60">
        <div className="divide-y">
          {items.map(item => (
            <div
              key={item.label}
              className="grid gap-2 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
            >
              <div className="min-w-0">
                <h2 className="text-sm font-medium">{item.label}</h2>
                <p className="text-sm text-muted-foreground">{item.description}</p>
              </div>
              <span className="text-sm text-muted-foreground">{item.value}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
