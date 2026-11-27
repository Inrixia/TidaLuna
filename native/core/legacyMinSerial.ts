// The lowest serial of luna-registry's signed legacy.json this build takes (legacyList.ts): a list signed before this
// build was made can't be replayed to it, even on a first start with nothing cached. Written by
// scripts/legacyMinSerial.mjs before a release build (the serial of the list signed then); keep it a plain number.
export const legacyMinSerial = 1;
