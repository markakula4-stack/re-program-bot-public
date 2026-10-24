import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {bootstrapTestTools} from './bootstrap-test-tools.mjs';
import {publicTestEnvironment} from './public-test-environment.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
bootstrapTestTools();
const manifest=JSON.parse(fs.readFileSync(path.join(root,'tests/public-tests.json'),'utf8'));
const requested=process.argv.slice(2);
const files=requested.length?requested:manifest.files;
if(!files.length||files.some(name=>!manifest.files.includes(name)))throw Error('Unknown public test selection');
const guard=pathToFileURL(path.join(root,'scripts/public-offline-guard.mjs')).href;
const env=publicTestEnvironment({guard});
const browserSuites=new Set(['tests/v1.4.3-demo-worker.test.mjs',
  'tests/v1.4.3-owner-subscription-review-ui.test.mjs',
  'tests/v1.4.3-subscription-view.test.mjs',
  'tests/v1.4.3-native-paid-residue.test.mjs']);
if(files.some(file=>browserSuites.has(file))) {
  const {chromium}=await import('../tests/p11-runtime/node_modules/playwright/index.mjs');
  const browser=process.env.P11_BROWSER_PATH||chromium.executablePath();
  if(!path.isAbsolute(browser)||!fs.existsSync(browser))
    throw Error('Install the pinned test browser with node node_modules/playwright/cli.js install chromium, or set P11_BROWSER_PATH.');
  env.P11_BROWSER_PATH=fs.realpathSync(browser);
  env.RUN_DEMO_BROWSER_TESTS='1';
  env.DEMO_SCREENSHOT_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'re-program-public-ui-'));
}
// Keep Windows laptops from running a large DOM fixture beside Chromium.
const concurrency=process.platform==='win32'?1:2;
const child=spawn(process.execPath,['--max-old-space-size=768','--no-warnings','--import',guard,'--experimental-loader',
  pathToFileURL(path.join(root,'tests/cloudflare-workers-loader.mjs')).href,
  '--test','--test-reporter=tap',`--test-concurrency=${concurrency}`,'--test-timeout=180000',...files],
  {cwd:root,env,stdio:'inherit'});
child.on('error',error=>{console.error(error.message);process.exitCode=1;});
child.on('exit',(code,signal)=>{process.exitCode=code??(signal?1:0);});
