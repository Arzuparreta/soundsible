import { splitProps, type JSX } from 'solid-js';

/** Native button semantics without a visual recipe. Pattern components own the
 * appearance; the default type cannot accidentally submit a containing form. */
export function Control(props: JSX.ButtonHTMLAttributes<HTMLButtonElement>) {
  const [local, rest] = splitProps(props, ['type']);
  return <button type={local.type ?? 'button'} {...rest} />;
}

export function IconButton(props: JSX.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  const [local, rest] = splitProps(props, ['label']);
  return <Control {...rest} aria-label={local.label} />;
}

export function RangeControl(props: Omit<JSX.InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  return <input {...props} type="range" />;
}
