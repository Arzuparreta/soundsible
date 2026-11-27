import type { JSX } from 'solid-js';

/** The heading and metadata beside a collection's artwork. Shells supply their own actions. */
export function EntityIdentity(props: {
  class: string;
  headingClass: string;
  headingRef?: (heading: HTMLHeadingElement) => void;
  title: JSX.Element;
  metadata?: JSX.Element;
}) {
  return (
    <div class={props.class}>
      <h1 ref={props.headingRef} class={props.headingClass}>{props.title}</h1>
      {props.metadata}
    </div>
  );
}
