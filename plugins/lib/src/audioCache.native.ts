// Holds these audio urls (https://*.audio.tidal.com) in memory, see native/audioCache.ts
export const audioCacheWindow = async (urls: string[]): Promise<void> => luna.audioCacheWindow(urls);
