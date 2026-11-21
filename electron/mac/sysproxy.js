'use strict';
// macOS system proxy (Safari, Chrome, most apps read it) through Apple's own networksetup tool.
// Set on every active network service (Wi-Fi, Ethernet, …), since the one in use can change at any
// time. Only what Best set itself is turned off again (see macProxySteps). The tool is started with
// an argument array and a fixed full path: nothing goes through a shell.

const { execFile } = require('child_process');
const { parseNetworkServices, parseProxyState, parseAutoProxy, macProxySteps } = require('../platform');

const NETWORKSETUP = '/usr/sbin/networksetup';

function ns(args) {
  return new Promise((resolve, reject) => {
    execFile(NETWORKSETUP, args, { timeout: 15000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const text = `${stdout || ''}${stderr || ''}`;
      // networksetup reports some failures on stdout with exit code 0 ("** Error: …").
      if (/requires admin privileges/i.test(text)) return reject(new Error('MAC_PROXY_ADMIN'));
      if (err || /\*\* Error/i.test(text)) return reject(new Error((text.trim() || (err && err.message) || 'networksetup failed').split('\n')[0].slice(0, 200)));
      resolve(String(stdout || ''));
    });
  });
}

/** mode: 'off' | 'on' | 'pac' | 'keep' (same meaning as on Windows). */
async function applySystemProxy(mode, settings) {
  if (mode === 'keep') return;
  const services = parseNetworkServices(await ns(['-listallnetworkservices']));
  if (!services.length) throw new Error('no network service found');
  const errors = [];
  // One service after the other: networksetup writes one shared preferences file.
  for (const service of services) {
    try {
      const current = {
        web: parseProxyState(await ns(['-getwebproxy', service])),
        secure: parseProxyState(await ns(['-getsecurewebproxy', service])),
        auto: parseAutoProxy(await ns(['-getautoproxyurl', service])),
      };
      for (const step of macProxySteps(service, mode, settings, current)) await ns(step);
    } catch (e) {
      if (e.message === 'MAC_PROXY_ADMIN') throw e; // the same for every service
      errors.push(`${service}: ${e.message}`);
    }
  }
  // A service that cannot take a proxy (a few VPN or modem entries) is not an error on its own.
  if (errors.length === services.length) throw new Error(errors[0]);
}

module.exports = { applySystemProxy };
