import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const runner=fileURLToPath(new URL('../../scripts/public-python-runner.py',import.meta.url));
export function runPublicPython(args,options={}) {
  const python=process.env.PUBLIC_TEST_PYTHON||(process.platform==='win32'?'python':'python3');
  const result=spawnSync(python,['-I','-S',runner,...args],options);
  if(result.error)throw new Error('Python 3.11+ is required; set PUBLIC_TEST_PYTHON to its executable path.',{cause:result.error});
  return result;
}
