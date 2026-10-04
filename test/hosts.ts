// Compile-time host contract: the loader needs no unsafe API cast.
import type { ExtensionAPI as PiAPI } from "@earendil-works/pi-coding-agent";
import type { DesktopAPI } from "../src/host.ts";

type Assert<T extends true> = T;
export type PiHost = Assert<PiAPI extends DesktopAPI ? true : false>;
