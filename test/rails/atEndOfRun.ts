const closers: (() => Promise<void>)[] = [];

/** `close` runs once, after the last test file (test/globalSetup.ts). */
export const closeAtEndOfRun = (close: () => Promise<void>) => {
  closers.push(close);
};

export const closeEverything = async () => {
  for (const close of closers.splice(0)) await close();
};
