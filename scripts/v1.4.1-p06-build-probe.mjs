import {build} from '../tests/p11-runtime/node_modules/esbuild/lib/main.js';
import {runPublicPython} from '../tests/helpers/public-python.mjs';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)),output=process.argv[2];
if(!output||!/^[a-f0-9]{40}$/u.test(process.env.GITHUB_SHA??''))throw new Error('p06_build_arguments_required');
await build({absWorkingDir:root,entryPoints:['tests/helpers/v1.4.1-p06-migration-probe.mjs'],bundle:true,format:'esm',platform:'browser',target:'es2022',external:['cloudflare:workers'],minify:true,outfile:output,
  plugins:[{name:'p06-fixed-schema',setup(b){b.onResolve({filter:/^p06:probe-schema$/},()=>({path:'fixed-schema',namespace:'p06-schema'}));b.onLoad({filter:/.*/,namespace:'p06-schema'},()=>{
    const r=runPublicPython(['scripts/v1.4.1-p06-probe-schema.py'],{cwd:root,encoding:'utf8',maxBuffer:4*1024*1024});if(r.status!==0)throw new Error('p06_schema_build_failed');return {loader:'js',contents:'export const P06_SCHEMA_BATCHES='+r.stdout+';'};
  });}}]});
const config={candidateSha:process.env.GITHUB_SHA,sourceBundleSha256:createHash('sha256').update(readFileSync(output)).digest('hex')};
writeFileSync(output,readFileSync(output,'utf8')+'\nglobalThis.__RE_PROGRAM_P06_PROBE_CONFIG__=Object.freeze('+JSON.stringify(config)+');\n');
writeFileSync(output+'.config.json',JSON.stringify(config)+'\n');
console.log(JSON.stringify({p06Build:'PASS',sourceBundleSha256:config.sourceBundleSha256}));
