#!/usr/bin/env node
import { handlePortInUse, PortInUseError, startServer } from './server.js';

startServer({ openBrowser: true, installSignalHandlers: true }).catch(async (e: unknown) => {
  if (e instanceof PortInUseError) {
    process.exit(await handlePortInUse(e));
  }
  console.error('Neo Commander başlatılamadı:');
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
