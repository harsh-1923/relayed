// A small icon button that copies text, and says so for a moment.
import { useEffect, useState } from 'react';
import { CopyCopied, CopyDefault } from '@relayed/icons';
import { cn } from '@/lib/utils';

export function CopyButton({ text, label, className }: { text: string; label: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => { setCopied(false); }, 1500);
    return () => { clearTimeout(timer); };
  }, [copied]);

  return (
    <button
      type="button"
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : 'Copy'}
      data-copied={copied || undefined}
      className={cn(
        'flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-opacity hover:bg-muted hover:text-foreground',
        className,
      )}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => { setCopied(true); });
      }}
    >
      {copied ? <CopyCopied className="size-3" /> : <CopyDefault className="size-3" />}
    </button>
  );
}
