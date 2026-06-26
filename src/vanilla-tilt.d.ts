// Minimal ambient types for `vanilla-tilt` (the package ships no usable .d.ts).
// Covers only the surface we use: the static initializer and the instance handle
// it stashes on the element so we can tear it down on the rail's rebuilds.

declare module "vanilla-tilt" {
  export interface TiltOptions {
    max?: number;
    perspective?: number;
    scale?: number;
    speed?: number;
    glare?: boolean;
    "max-glare"?: number;
    "glare-prerender"?: boolean;
    gyroscope?: boolean;
    reverse?: boolean;
    easing?: string;
  }

  export default class VanillaTilt {
    static init(
      el: HTMLElement | HTMLElement[] | NodeListOf<HTMLElement>,
      options?: TiltOptions
    ): void;
    destroy(): void;
  }
}
