export declare const html: (strings: TemplateStringsArray, ...values: any[]) => any;
export declare function render(vnode: any, parent: Element): void;
export declare function useState<T>(init: T | (() => T)): [T, (v: T | ((prev: T) => T)) => void];
export declare function useEffect(fn: () => void | (() => void), deps?: readonly unknown[]): void;
export declare function useRef<T>(init: T): { current: T };
