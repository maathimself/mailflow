import { createElement, useEffect, useRef } from 'react';

// Builds a React component around emoji-mart's vanilla Picker custom element.
// The Picker class is injected so the lifecycle can be tested without a real
// custom-element registry. This replaces @emoji-mart/react, whose peer range
// stops at React 18.
export function createEmojiPicker(PickerClass) {
  return function EmojiPicker(props) {
    const containerRef = useRef(null);
    const instanceRef = useRef(null);
    const mountedPropsRef = useRef(null);

    useEffect(() => {
      // The Picker constructor clears the container and appends itself to it.
      const instance = new PickerClass({ ...props, ref: containerRef });
      instanceRef.current = instance;
      mountedPropsRef.current = props;
      return () => {
        instanceRef.current = null;
        mountedPropsRef.current = null;
        if (typeof instance.remove === 'function') instance.remove();
      };
      // Mount once; later prop changes are pushed through update() below.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
      const instance = instanceRef.current;
      if (!instance) return;
      // Skip the render that created the instance with these very props.
      if (mountedPropsRef.current === props) return;
      mountedPropsRef.current = props;
      instance.update(props);
    });

    return createElement('div', { ref: containerRef });
  };
}
