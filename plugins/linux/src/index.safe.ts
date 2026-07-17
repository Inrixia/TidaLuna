import { Tracer, type LunaUnload } from "@luna/core";

export const unloads = new Set<LunaUnload>();
export const { trace: linuxTrace, errSignal } = Tracer("[@luna/linux]");
