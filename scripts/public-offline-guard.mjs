// Test isolation, not an OS security sandbox. CI never receives production secrets.
import '../tests/helpers/v1.4.3-p05-offline-network.mjs';
import cp from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {syncBuiltinESMExports} from 'node:module';
if(!globalThis.__RE_PUBLIC_TEST_CHILD_GUARD__){
  const pythonRunner=fileURLToPath(new URL('./public-python-runner.py',import.meta.url));
  const readGit=new Set(['show','rev-parse','ls-tree','log','status','diff','show-ref','cat-file','rev-list','hash-object','ls-files']);
  for(const method of ['spawn','spawnSync','execFile','execFileSync']){
    const original=cp[method];
    cp[method]=function(command,args=[],options,...rest){
      if(!Array.isArray(args))throw Error('OFFLINE_TEST_CHILD_ARGUMENTS_BLOCKED');
      if(options?.shell)throw Error('OFFLINE_TEST_SHELL_BLOCKED');
      const normalized=String(command).replaceAll('\\','/');
      if(normalized.endsWith('/node_modules/esbuild/bin/esbuild')){args=[command,...args];command=process.execPath;}
      const name=path.basename(String(command)).toLowerCase();
      const node=name==='node'||name==='node.exe';
      const build=(name==='esbuild'||name==='esbuild.exe')&&normalized.includes('/node_modules/@esbuild/');
      const git=(name==='git'||name==='git.exe')&&readGit.has(String(args[0]));
      const python=/^python(?:3(?:\.\d+)?)?(?:\.exe)?$/u.test(name)&&args[0]==='-I'&&args[1]==='-S'&&args[2]===pythonRunner;
      // The runner selects one installed browser. Never admit arbitrary chrome
      // binaries from PATH; test contexts deny network before opening a page.
      const browser=path.isAbsolute(String(command))&&process.env.P11_BROWSER_PATH&&
        path.resolve(String(command))===path.resolve(process.env.P11_BROWSER_PATH);
      if(!node&&!build&&!git&&!python&&!browser)throw Error('OFFLINE_TEST_CHILD_BLOCKED');
      if(node&&options?.env)options={...options,env:{...options.env,NODE_OPTIONS:process.env.NODE_OPTIONS}};
      return original.call(this,command,args,options,...rest);
    };
  }
  for(const method of ['exec','execSync'])cp[method]=()=>{throw Error('OFFLINE_TEST_SHELL_BLOCKED');};
  syncBuiltinESMExports();globalThis.__RE_PUBLIC_TEST_CHILD_GUARD__=true;
}
