'use client';

import { useEffect, useRef, type ReactNode } from 'react';

export function FooterDither({ children }: { children: ReactNode }) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    const canvas = canvasRef.current;
    const image = wrapper?.querySelector('img');
    if (!wrapper || !canvas || !image) return;
    const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
    let disposed = false;
    let pending = false;
    let nearby = false;
    let destroy: (() => void) | null = null;

    async function initialize() {
      if (
        disposed ||
        pending ||
        destroy ||
        !nearby ||
        motionPreference.matches ||
        !image!.complete ||
        !image!.naturalWidth
      )
        return;
      pending = true;
      try {
        const { createImageDither } = await import('./retro-dither-image');
        if (!disposed && !motionPreference.matches) {
          destroy = createImageDither(canvas!, image!, wrapper!.parentElement ?? wrapper!);
        }
      } catch {
        // The server-rendered photo remains visible if the decorative effect cannot load.
      } finally {
        pending = false;
      }
    }

    // One wrapper, held: `initialize` is async, and handing a promise-returning
    // function to addEventListener floats its rejection. It also has to be the
    // SAME reference on the way out or removeEventListener matches nothing.
    const onInitialize = () => {
      void initialize();
    };

    const observer = new IntersectionObserver(
      ([entry]) => {
        nearby = entry?.isIntersecting ?? false;
        void initialize();
      },
      { rootMargin: '200px' },
    );
    observer.observe(wrapper);
    image.addEventListener('load', onInitialize);
    motionPreference.addEventListener('change', onInitialize);
    return () => {
      disposed = true;
      observer.disconnect();
      image.removeEventListener('load', onInitialize);
      motionPreference.removeEventListener('change', onInitialize);
      destroy?.();
    };
  }, []);

  return (
    <div ref={wrapperRef} className="absolute inset-0">
      {children}
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        className="pointer-events-none invisible absolute inset-0 size-full"
      />
    </div>
  );
}
