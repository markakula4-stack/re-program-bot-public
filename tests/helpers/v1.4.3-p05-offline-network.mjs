// Load before the test graph with --import. Even an accidentally captured
// native fetch or missed mock cannot contact Telegram or any other host.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import {syncBuiltinESMExports} from 'node:module';
const deny=()=>{throw Object.assign(new Error('part05_offline_network_forbidden'),{code:'PART05_OFFLINE_NETWORK_FORBIDDEN'});};
globalThis.fetch=async()=>deny();
for(const module of [http,https])for(const name of ['request','get'])module[name]=deny;
for(const name of ['connect','createConnection'])net[name]=deny;
net.Socket.prototype.connect=deny;
tls.connect=deny;
for(const name of ['lookup','resolve','resolve4','resolve6'])dns[name]=deny;
for(const name of ['lookup','resolve','resolve4','resolve6'])dns.promises[name]=async()=>deny();
syncBuiltinESMExports();
globalThis.__RE_PART05_OFFLINE_NETWORK_BLOCKED__=true;
