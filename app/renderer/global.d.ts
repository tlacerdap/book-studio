import type { StudioApi } from "../shared/api.ts";

declare global {
  interface Window {
    studio: StudioApi;
  }
}
export {};
