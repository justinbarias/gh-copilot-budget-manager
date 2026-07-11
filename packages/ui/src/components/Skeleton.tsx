import type { CSSProperties, ReactNode } from 'react';
import './Skeleton.css';

export type SkeletonVariant = 'line' | 'block' | 'pill';

export interface SkeletonProps {
  /** Shape: 'line' (text-row rhythm), 'block' (chart/card-filling rect), 'pill' (tab/badge). Default 'line'. */
  variant?: SkeletonVariant;
  /** CSS width -- a number is treated as px, a string passed through as-is (e.g. '60%'). Omit to fill the parent. */
  width?: number | string;
  /** CSS height -- same rules as `width`. Omit to use the variant's default rhythm height. */
  height?: number | string;
  className?: string;
}

function toCssSize(value: number | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'number' ? `${value}px` : value;
}

/**
 * One skeleton primitive -- a shimmering placeholder rectangle/pill/line.
 * Purely decorative (the loading semantics live on the enclosing
 * `SkeletonGroup`'s role="status"), so every instance is aria-hidden.
 */
export function Skeleton({ variant = 'line', width, height, className }: SkeletonProps) {
  const style: CSSProperties = {
    width: toCssSize(width),
    height: toCssSize(height),
  };
  return (
    <span aria-hidden="true" className={`skeleton skeleton--${variant}${className ? ` ${className}` : ''}`} style={style} />
  );
}

export interface SkeletonGroupProps {
  children: ReactNode;
  className?: string;
  /** aria-label for the group's role="status" -- default 'Loading' (CLAUDE.md §7/§6.7's a11y-plus-visual gate: screen readers and the visual shimmer must agree the screen is loading). */
  label?: string;
}

/**
 * Wraps a screen/modal's skeleton layout as a single accessible loading
 * region: role="status" + aria-label so assistive tech announces "Loading"
 * once, while its children (plain `Skeleton` primitives, laid out inside the
 * screen's OWN existing wrapper classNames so the shape approximates the
 * loaded layout's rhythm) stay individually aria-hidden. `data-testid="skeleton"`
 * is the stable hook e2e/tests assert on instead of the old "Loading…" text.
 */
export function SkeletonGroup({ children, className, label = 'Loading' }: SkeletonGroupProps) {
  return (
    <div className={`skeleton-group${className ? ` ${className}` : ''}`} role="status" aria-label={label} data-testid="skeleton">
      {children}
    </div>
  );
}
