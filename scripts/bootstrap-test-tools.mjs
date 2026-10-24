// Preserve the legacy module paths while keeping one pinned dependency tree.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
export function bootstrapTestTools(){
  const dependencies=path.join(root,'node_modules');
  for(const group of ['p11-runtime','p08-ui']){
    const target=path.join(root,'tests',group,'node_modules');
    if(fs.existsSync(target))continue;
    if(!fs.existsSync(path.join(dependencies,'esbuild'))||!fs.existsSync(path.join(dependencies,'linkedom')))
      throw new Error('Install pinned development dependencies with npm ci --ignore-scripts first.');
    fs.mkdirSync(path.dirname(target),{recursive:true});
    fs.symlinkSync(dependencies,target,process.platform==='win32'?'junction':'dir');
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))bootstrapTestTools();
