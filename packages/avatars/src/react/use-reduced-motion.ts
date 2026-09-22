import { useEffect, useState } from 'react';

/**
 * Whether this reader has asked for less motion.
 *
 * CSS handles its own animations through the media query; this exists for the
 * cases CSS cannot reach — SMIL, which ignores stylesheets entirely, so the
 * only way to stop it is not to render the element.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(query.matches);
    onChange();
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return reduced;
}
