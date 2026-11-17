'use strict';
// Builds configs for many sample servers and asks the real cores to validate them:
//   xray run -test -c <file>      sing-box check -c <file>
// Usage: node scripts/validate-configs.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseLink } = require('../src/core/links');
const { b64encode } = require('../src/core/util');
const { DEFAULT_SETTINGS, DEFAULT_ROUTING, sanitizeRouting } = require('../src/core/settings');
const { buildXrayConfig, buildXrayTestConfig, needsSingBox } = require('../src/core/xray-config');
const { buildSingBoxConfig, buildTunConfig, buildSingBoxTestConfig } = require('../src/core/singbox-config');

const ROOT = path.join(__dirname, '..');
const XRAY = path.join(ROOT, 'resources', 'cores', 'xray', 'xray.exe');
const SINGBOX = path.join(ROOT, 'resources', 'cores', 'sing-box', 'sing-box.exe');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'best-validate-'));

const UUID = '0b6d8a1c-1111-4c2d-9e3f-123456789abc';
const PBK = 'Z84J2IelR9ch3k8VtlVhhs5ycBUlXA7wHBWcBrjqnAw';
const links = [
  `vless://${UUID}@example.com:443?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.microsoft.com&fp=chrome&pbk=${PBK}&sid=6ba85179&type=tcp#reality`,
  `vless://${UUID}@1.2.3.4:8443?type=ws&security=tls&host=cdn.example.org&path=%2Fws%3Fed%3D2048&sni=cdn.example.org&alpn=h2,http/1.1#ws`,
  `vless://${UUID}@x.example.com:443?type=xhttp&security=tls&path=%2Fx&mode=auto#xhttp`,
  `vless://${UUID}@g.example.com:443?type=grpc&security=tls&serviceName=svc&mode=multi#grpc`,
  `vless://${UUID}@h.example.com:443?type=httpupgrade&security=tls&path=%2Fhu&host=h.example.com#hu`,
  `vless://${UUID}@10.0.0.5:80?type=tcp&headerType=http&host=a.com&path=%2F#tcp-http`,
  `vless://${UUID}@k.example.com:80?type=kcp&security=tls#kcp`,
  'vmess://' + b64encode(JSON.stringify({ v: '2', ps: 'vm', add: 'vm.example.com', port: '443', id: UUID, aid: '0', scy: 'auto', net: 'ws', type: 'none', host: 'vm.example.com', path: '/', tls: 'tls', sni: 'vm.example.com' })),
  'trojan://secret@t.example.com:443?sni=t.example.com#tr',
  'ss://' + b64encode('aes-256-gcm:pw', true) + '@5.6.7.8:8388#ss',
  'ss://2022-blake3-aes-128-gcm:' + encodeURIComponent('MTIzNDU2Nzg5MDEyMzQ1Ng==') + '@5.6.7.8:8388#ss2022',
  'socks://' + b64encode('u:p', true) + '@9.9.9.9:1080#socks',
  'hy2://pw@h.example.com:8443/?sni=h.example.com&obfs=salamander&obfs-password=x&insecure=1#hy2',
  `tuic://${UUID}:pw@t.example.com:443?congestion_control=bbr&alpn=h3&sni=t.example.com#tuic`,
  `vless://${UUID}@h2.example.com:443?type=http&security=tls&path=%2Fh2&host=h2.example.com#h2`,
  `vmess://${UUID}@q.example.com:443?type=quic&security=tls#quic`,
  'ss://' + b64encode('aes-128-gcm:pw', true) + '@5.6.7.8:8388/?plugin=' + encodeURIComponent('obfs-local;obfs=http;obfs-host=www.bing.com') + '#ss-obfs',
  'ss://' + b64encode('aes-128-gcm:pw', true) + '@5.6.7.8:443/?plugin=' + encodeURIComponent('v2ray-plugin;mode=websocket;tls;host=a.com;path=/ws') + '#ss-v2ray',
  'hysteria://h1.example.com:443?protocol=udp&auth=pw&peer=h1.example.com&upmbps=20&downmbps=80&alpn=hysteria&obfsParam=xx#hy1',
  'anytls://pw@a.example.com:443/?sni=a.example.com&fp=chrome#anytls',
  'naive+https://user:pass@n.example.com:443#naive',
  'naive+quic://user:pass@n.example.com:443#naive-quic',
  `vless://${UUID}@plain.example.com:80?type=ws&path=%2Fws&host=cdn.example.com#plain-ws`,
  `vless://${UUID}@plain.example.com:80?type=tcp#plain-tcp`,
  `vless://${UUID}@plain.example.com:80?type=xhttp&path=%2Fx#plain-xhttp`,
  `vless://${UUID}@plain.example.com:80?type=grpc&serviceName=g#plain-grpc`,
  `vless://${UUID}@plain.example.com:80?type=kcp#plain-kcp`,
  'trojan://pw@plain.example.com:80?security=none&type=ws&path=%2F#plain-trojan',
  `vless://${UUID}@new.example.com:443?type=tcp&security=tls&sni=new.example.com&fp=chrome&pcs=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&vcn=new.example.com&cs=TLS_AES_128_GCM_SHA256&fm=%7B%22tcp%22%3A%5B%7B%22type%22%3A%22fragment%22%2C%22settings%22%3A%7B%22packets%22%3A%22tlshello%22%2C%22length%22%3A%22100-200%22%2C%22delay%22%3A%2210-20%22%7D%7D%5D%7D#tls-extras`,
  `vless://${UUID}@ech.example.com:443?type=ws&path=%2F&security=tls&sni=ech.example.com&ech=${encodeURIComponent('cloudflare-ech.com+https://1.1.1.1/dns-query')}#ech`,
  `vless://${UUID}@r.example.com:443?type=tcp&security=reality&sni=www.microsoft.com&fp=chrome&pbk=${PBK}&sid=ab12&pqv=eajD4hn7M5-AdrgFErV3x-SKho2caLv6s8sbhtuK9lW6mRnqZoJ8va_2xRZNAvr9Hgnx238zqANgT_EFMOYmBQ-f8ejXoYVIGDuX5hRMh0EiHdmGVJ-yGetWguwveHgdfMWeAkfocsdfHWqgUgdthg0pM71FsDPG7_d3HaAWl8_ZsldqOcLsoMAkeGrco3nX1mzLf8WNQSdpPXhVdoKnON1mlp5MVKsmwVYy1xqmXYk-6uiHcj-Xxb4PVaFpK-3gtfcL_85v7mnDZQH0s9wWbIv1B3xFT7kCcZ941uLEuPH7CRzCR1mtZWNNKktiPe2GfKBmReJ7mpq6Kn_Y1e3tYPIL_J1dZLhmVoRFQ4LsZZqgO3ddoMUG7bnTe3UDsGmAAvt4sPFjshjh3PjDNXsmzdz_NdSm6-0YFy0o6Ap6-otdnW9egAuT_yoYRn5tSIL0eqI1fnTZPQGzyy8Fl2F1RfHMPHvgFP9pj-0B0tNjNAeX1JE6-0EiRq3qvFd36TDnm1tH1IKSM6tXK0eNJeB7Qo3olWOQiA8BPOHJdFEMQ77v9E225l9KOtgWteR4yhQyKmFuV1GFCJWq0rPbiTpSX6vEWoXi9sJ6BQP_e84JV1t_LeC4cWAUYTFHdmTvK4dqQptmb2facw3WMdLDZUhfpNYO_CfVlEZuRSxRAyXL-gk707iBFSG1JpT6XqK6FnUHs1mqHdfPBWl6muXsR_w0LS3fqaeRS_Jx6dk7vfRcTmlRgAfokFaZHiFD-r0PY6ltSv6zl5R_-NyNZcO4Cz9cpnI-JODQzI4swKAcZ25uIQdhFfBYv5n3wIHg9KIGqu2hWPisDcxISLoKI04OTb_E9hdYzNTGVLJNEmpu3q0FUS4HT-Gnt3l5K2BMTV4rlg4VRfhjsq2QmDFn4VWhoyAtooZun9cYaStFlQFT2wCrNnenmuD4UOafNOgQ-kEUbX5E0Edt_FEFpS35zmz8yo3N9Msr1GnR7QCtlkvjpW6hiCO7NkyY9crH5Fl-vrpbDxWnXI5XDtWus7GAxMd4Phj0GZwUIO6Z0syULuWXXtpIzB9dZS-piHKg9sgZAioxXshnODtPYwwLTXNy-HatWK2JYrFNHsRDOYp6DZyW6a00NMKG81rxCiTJ0ryy_9o3ItZSr4eHNlCM-XeS0HzkCYiog80BuEPl0eHhEc8fuWJPj7j3P_OWyE1ntzBke3HiBMICrgLuWYXIrI21cZg0rlqp7a9DQ8ARMZXqshPQ9ztTzF3rvL-ORHCGTFcWNcego0zI8vhmGFBGhWTbDb9k3s76JBWmR6x-4CKb4sbwFeQnEM9jyzjq97-APwN3NecHIUhO3awzx_QONRuxVUB9y4gTuA1jIm20y_sKpGCs4A_qgopk6P4qbqqwe8WKDn4bgmDVdDeIcbJOgS4BqrGBhDHuHDAVMvpv4tq6QwmqiI-pMWWzPEtE-DF7zfuANQ0YCAACa9385Wugnf-H9IYDdnotMSCcIvxIiBxMZAghWCVE41hQsu1D5dkIIfJjRss9deCDr6BYaZ0hcUcR5YVgzWT1xZ3BEa5QIcyOzN0RoDGezhF-SeTUBvj6WYh54CIbg1Wiyl_-_5K0Urbdy1M0stMfh6peF8xG-I9rzFvWn3S3JB_nMDq3fcdNflh7O4ZutN6eE9KBf-1YJ1R_Y9aKDbuvkfVSAv91Wyc1gV9kpihuHKB52-ZHQ_sDyUVHZFD3HiA_CWcZgLyoQJIZPfiq0-bi8jJ9xmxxmklNvps9P7D5jt6gdtCYZwKv49AzLwKlGGOl_iuaDe7yUMYyyh1ks0d3TMcBf6tL3TsYXaZ888tg399Xbt4slMU52e91udbzxoRSVy5MKmQBRMP8i8eTtYFbrd66lnIqjwM7iC3N1fmI21lGbfm6R50IH9NE9HBuDr9GWAbJfhrLA7aaRpv8w9PUk0nzNtjTlfNZKaEF0wXNFIYB2c_2yqjKShFFeRg1ITokHyBXhqCUYQELWka3-0UcK_V2oc9v-q2qJY6Gm0K9tKeuJaXCHazqMBHOQ1PFx-L4iq0ksuDoCy97zwyuqXdpoo9Eda7FWIenzcExd_kZQEMV8c5SLNUagMpph91kEXVYKbpedz_XIJB6FQN69yWlfbonKTEI4uGcm7xxOn9wXVzOpj0BX1017CAmG57HJGY65KzQgXszs7JhNpWuWIyHx009HSpWsVQKAWyvzAnnAG0oLgPANwZnVJW3YhQlF5GjcHQK0Q_OWXRWJNJ6WVO9lQFYWb2_PmsN-oirU4g9GkZbEAQe_miPgos4Ldg2qqKN8882156dkLYBJN80xZRiSCrrMb9E3fn_nRUQrl2qz1Yz0vWngxLvLjQ36pKrY749bXUU9gysEgSbBNgJfgs8Z7Czcn2RYHY5UHUj5K6UoITKMh0_9D-h0ucn7EoUveaEpx6F7luS28SJdRQhnYhLhKj8_mqVfDu1D8DiC9QZluqeBllGodwhdb5U1yfd8ACObYpn4-ejj6agAsicMAu7x_InZ797iseqO14d_YQJx7We_BlSddEESPpqwuXRwrctCwwmttvfBkz08i_Qn7tLuN3srjjVAn5BwR6Xxa5a4UM#pqv`,
  `vless://${UUID}@g2.example.com:443?type=grpc&security=tls&serviceName=svc&authority=cdn.example.com#grpc-authority`,
  `vless://${UUID}@k2.example.com:443?type=kcp&security=tls&mtu=1350&tti=20#kcp-mtu`,
  `vless://${UUID}@xh.example.com:443?type=xhttp&security=tls&path=%2Fx&x_padding_bytes=100-1000&extra=%7B%22xPaddingBytes%22%3A%22100-1000%22%2C%22xmux%22%3A%7B%22maxConcurrency%22%3A%2216-32%22%7D%2C%22noGRPCHeader%22%3Afalse%7D#xhttp-extra`,
  'hysteria2://pw@h3.example.com:443/?sni=h3.example.com&obfs=gecko&obfs-password=secret&minPacketSize=100&maxPacketSize=1200&pinSHA256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&mport=20000-30000#hy2-gecko-xray',
  'hysteria2://pw@h4.example.com:443/?sni=h4.example.com&obfs=salamander&obfs-password=secret&mport=20000-30000,443#hy2-hop-singbox',
  'wireguard://' +encodeURIComponent('yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=') + '@162.159.192.1:2408/?publickey=' + encodeURIComponent('bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=') + '&address=172.16.0.2/32&reserved=1,2,3&mtu=1280#wg',
];

const servers = [];
for (const l of links) {
  try { servers.push(parseLink(l)); } catch (e) { console.log('PARSE FAIL', l.slice(0, 40), e.message); }
}

const { effectiveRouting } = require('../src/core/routing');
const R = (x) => effectiveRouting(sanitizeRouting(x));
const custom = { profiles: [{ id: 'p-x', name: 'x', base: 'direct', rules: [
  { outbound: 'proxy', domain: ['example.org', 'full:a.com', 'geosite:google'] },
  { outbound: 'block', ip: ['8.8.8.8/32'] },
  { outbound: 'direct', port: ['443', '1000-2000'], network: 'tcp' },
  { outbound: 'proxy', process: ['telegram.exe'] },
  { outbound: 'block', protocol: ['bittorrent'] },
  { outbound: 'direct', domain: ['keyword:bank'], network: 'udp', port: ['53'] },
] }], activeId: 'p-x', singboxStrategy: 'ipv4_only' };
const routings = [
  R(DEFAULT_ROUTING),
  R({ mode: 'bypass-ir' }),
  R({ country: 'de' }),
  R({ country: 'cn', activeId: 'p-global' }),
  R({ country: 'br', activeId: 'p-direct' }),
  R(custom),
];
const settingsVariants = [DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, fragment: true, mux: true, allowLan: true, lanUser: 'u', lanPass: 'p' }];

let fail = 0;
let n = 0;
function check(name, cfg, core, env) {
  n++;
  const file = path.join(tmp, `${n}.json`);
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  const r = core === 'xray'
    ? spawnSync(XRAY, ['run', '-test', '-c', file], { encoding: 'utf8', cwd: path.dirname(XRAY), env: env ? { ...process.env, ...env } : process.env })
    : spawnSync(SINGBOX, ['check', '-c', file], { encoding: 'utf8', cwd: tmp });
  const ok = r.status === 0;
  if (!ok) {
    fail++;
    const out = r.error ? `spawn error: ${r.error.message}` : `${r.stdout || ''}${r.stderr || ''}`;
    console.log(`FAIL [${core}] ${name}\n${out.trim().split('\n').slice(-4).join('\n')}\n`);
  }
}

for (const s of servers) {
  for (const rt of routings) {
    for (const st of settingsVariants) {
      const label = `${s.remark} / ${rt.mode} / frag=${st.fragment}`;
      if (needsSingBox(s)) check(label, buildSingBoxConfig(s, st, rt), 'sing-box');
      else check(label, buildXrayConfig(s, st, rt, { loopbackPort: 39999 }), 'xray');
    }
  }
}
const xs = servers.filter((s) => !needsSingBox(s));
const ss = servers.filter((s) => needsSingBox(s));
check('xray test config', buildXrayTestConfig(xs, DEFAULT_SETTINGS, 30000), 'xray');
check('sing-box test config', buildSingBoxTestConfig(ss, 31000), 'sing-box');
check('tun config', buildTunConfig(DEFAULT_SETTINGS), 'sing-box');
check('tun config v4 only', buildTunConfig({ ...DEFAULT_SETTINGS, tunIpv6: false, remoteDns: 'tls://8.8.8.8' }), 'sing-box');

// Clash YAML → servers → configs, and a JSON-subscription config on Best's own ports.
{
  const { parseContent } = require('../src/core/subscription');
  const { withOwnInbounds, xrayTestConfig } = require('../src/core/custom');
  const yaml = fs.readFileSync(path.join(__dirname, '..', 'test', 'formats.test.js'), 'utf8').split('const CLASH = `')[1].split('`;')[0].split('${UUID}').join(UUID);
  for (const s of parseContent(yaml).servers) {
    if (needsSingBox(s)) check(`clash ${s.remark}`, buildSingBoxConfig(s, DEFAULT_SETTINGS, routings[0]), 'sing-box');
    else check(`clash ${s.remark}`, buildXrayConfig(s, DEFAULT_SETTINGS, routings[0], { loopbackPort: 39999 }), 'xray');
  }
  const json = { remarks: 'j', inbounds: [{ tag: 'socks', protocol: 'socks', port: 10808 }, { protocol: 'tun' }], outbounds: [{ tag: 'proxy', protocol: 'vless', settings: { vnext: [{ address: 'j.example.com', port: 443, users: [{ id: UUID, encryption: 'none' }] }] }, streamSettings: { network: 'tcp', security: 'tls' } }, { tag: 'direct', protocol: 'freedom' }] };
  check('json sub on own ports', withOwnInbounds(json, 'xray', DEFAULT_SETTINGS), 'xray');
  check('json sub test config', xrayTestConfig(json, 40000), 'xray');
}
// Optional Iran rule files (ext:geosite_IR.dat / ext:geoip_IR.dat), when downloaded for the test.
{
  const irDir = process.env.BEST_IR_GEO;
  if (irDir && fs.existsSync(path.join(irDir, 'geosite.dat'))) {
    const asset = path.join(tmp, 'asset');
    fs.mkdirSync(asset);
    for (const f of ['geoip.dat', 'geosite.dat']) fs.copyFileSync(path.join(path.dirname(XRAY), f), path.join(asset, f));
    fs.copyFileSync(path.join(irDir, 'geosite.dat'), path.join(asset, 'geosite_IR.dat'));
    fs.copyFileSync(path.join(irDir, 'geoip.dat'), path.join(asset, 'geoip_IR.dat'));
    const r = { ...sanitizeRouting({ country: 'ir', activeId: 'p-local' }) };
    const eff = { ...require('../src/core/routing').effectiveRouting(r), geoExt: { ir: true } };
    check('iran ext rules', buildXrayConfig(servers[0], DEFAULT_SETTINGS, eff), 'xray', { XRAY_LOCATION_ASSET: asset });
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${n - fail}/${n} configs valid`);
process.exit(fail ? 1 : 0);
