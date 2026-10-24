import path from 'node:path';

export function publicTestEnvironment({source=process.env,executable=process.execPath,
  platform=process.platform,guard}={}) {
  const windows=platform==='win32',paths=windows?path.win32:path.posix;
  const pathKey=Object.keys(source).find(key=>windows?/^path$/iu.test(key):key==='PATH');
  const originalPath=pathKey?source[pathKey]:'';
  const env=Object.fromEntries(Object.entries(source).filter(([key])=>
    !(windows?/^path$/iu.test(key):key==='PATH')&&
    !/(?:token|secret|password|credential|api.?key|cloudflare|github|openai|telegram)/iu.test(key)));
  // A plain object is case-sensitive even on Windows. Keep exactly one PATH
  // key, otherwise Node may select the new empty PATH and discard old Path.
  env.PATH=paths.dirname(executable)+(originalPath?paths.delimiter+originalPath:'');
  env.NODE_OPTIONS=`--import=${guard}`;
  env.CI='true';env.WRANGLER_SEND_METRICS='false';
  return env;
}
