import { splitProps, type JSX } from 'solid-js';
import styles from './Button.module.css';

type Variant = 'primary' | 'secondary' | 'ghost';
type Size = 'md' | 'sm';

export interface ButtonProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

/** Foundational button. Variants: primary (accent), secondary (raised), ghost. */
export default function Button(props: ButtonProps) {
  const [local, rest] = splitProps(props, ['variant', 'size', 'class', 'children']);
  const cls = () =>
    [styles.btn, styles[local.variant ?? 'primary'], styles[local.size ?? 'md'], local.class]
      .filter(Boolean)
      .join(' ');
  return (
    <button type="button" {...rest} class={cls()}>
      {local.children}
    </button>
  );
}
