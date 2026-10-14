// Minimal global store with a hook.
import { useEffect, useState } from "preact/hooks";
import type { Me } from "../shared/types";

type Listener = () => void;

export function createStore<T>(initial: T) {
  let value = initial;
  const listeners = new Set<Listener>();
  return {
    get: () => value,
    set(next: T | ((v: T) => T)) {
      value = typeof next === "function" ? (next as (v: T) => T)(value) : next;
      listeners.forEach((l) => l());
    },
    use(): T {
      const [, force] = useState(0);
      useEffect(() => {
        const l = () => force((n) => n + 1);
        listeners.add(l);
        return () => void listeners.delete(l);
      }, []);
      return value;
    },
  };
}

export const meStore = createStore<Me | null>(null);

/** True while a text field has focus, i.e. the on-screen keyboard is probably up (kept by main.tsx). */
export const keyboardStore = createStore(false);
