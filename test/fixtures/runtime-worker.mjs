import { openControl } from '../../scripts/runtime.mjs';

const control = await openControl(process.cwd(), { onStop: async () => {
  await new Promise(resolve => setTimeout(resolve, 150));
  await control.close();
} });
control.update('ready');
