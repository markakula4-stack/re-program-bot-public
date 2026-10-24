// Reproducible offline source bundles. No upload, database write or release activation.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {bootstrapTestTools} from './bootstrap-test-tools.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
bootstrapTestTools();
const {build,version}=await import('../tests/p11-runtime/node_modules/esbuild/lib/main.js');
if(version!=='0.25.12')throw Error('Pinned compiler version required');
const check=spawnSync(process.execPath,['scripts/v1.4.0-rebuild-build-assets.mjs','--check'],{cwd:root,stdio:'inherit'});
if(check.status!==0)throw Error('Generated UI assets are stale');
const entries={bot:'src/v1.4.4/released-entrypoint.mjs',support:'support-bot/src/worker.mjs',demo:'src/v1.4.3-demo/worker.mjs'};
const rows=[];
fs.mkdirSync(path.join(root,'dist'),{recursive:true});
for(const [name,entry] of Object.entries(entries)){
  const result=await build({absWorkingDir:root,entryPoints:[entry],bundle:true,write:false,
    format:'esm',platform:'browser',target:'es2022',external:['cloudflare:workers'],minify:true,metafile:true});
  const bytes=result.outputFiles[0].contents;
  fs.writeFileSync(path.join(root,'dist',name+'.mjs'),bytes);
  rows.push({name,entry,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),inputs:Object.keys(result.metafile.inputs).sort()});
}
fs.writeFileSync(path.join(root,'dist/build-manifest.json'),JSON.stringify({compiler:version,deployed:false,bundles:rows},null,2)+'\n');
console.log(JSON.stringify(rows.map(({name,bytes,sha256})=>({name,bytes,sha256}))));
