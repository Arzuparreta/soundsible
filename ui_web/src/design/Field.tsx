import type { JSX } from 'solid-js';

type Named = { 'aria-label': string } | { 'aria-labelledby': string };

/** Native field behavior with an explicit accessible name. Visual recipes stay
 * with the form or toolbar that owns the field. */
export function Field(props: JSX.InputHTMLAttributes<HTMLInputElement> & Named) {
  return <input {...props} />;
}

export function Select(props: JSX.SelectHTMLAttributes<HTMLSelectElement> & Named) {
  return <select {...props} />;
}
