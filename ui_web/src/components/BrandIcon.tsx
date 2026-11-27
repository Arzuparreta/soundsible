import styles from './BrandIcon.module.css';

export function BrandIcon(props: { class?: string }) {
  return (
    <img
      class={props.class ? `${styles.icon} ${props.class}` : styles.icon}
      src={`${import.meta.env.BASE_URL}icons/icon-192.png`}
      alt=""
    />
  );
}
