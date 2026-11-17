'use strict';
// "My country goes direct": which domain / IP lists describe a country.
// IP lists exist for every country (geoip.dat from v2fly/geoip). Curated domain lists only exist
// for a few countries; everywhere else the country's own top-level domain (e.g. .de) is used.

const GEOSITE = {
  cn: 'cn',
  ir: 'category-ir',
  ru: 'category-ru',
};

// Richer country lists Best can install from Updates (same files and tags 3x-ui uses).
const EXT = {
  ir: { domains: ['ext:geosite_IR.dat:ir'], ips: ['ext:geoip_IR.dat:ir'] },
  ru: { domains: ['ext:geosite_RU.dat:ru-available-only-inside'], ips: ['ext:geoip_RU.dat:ru'] },
};

/** Xray routing values. `ext` says which optional country files are installed ({ ir, ru }). */
function xrayCountryRules(cc, ext = {}) {
  if (!/^[a-z]{2}$/.test(cc || '')) return null;
  const domains = [`regexp:\\.${cc}$`];
  if (GEOSITE[cc]) domains.unshift(`geosite:${GEOSITE[cc]}`);
  const ips = [`geoip:${cc}`];
  if (ext && ext[cc] && EXT[cc]) { domains.unshift(...EXT[cc].domains); ips.unshift(...EXT[cc].ips); }
  return { domains, ips };
}

/** Extra blocking from the Iran rule files (malware / phishing / crypto-mining), when installed. */
function securityBlockRules(ext = {}) {
  if (!ext || !ext.ir) return null;
  return {
    domains: ['ext:geosite_IR.dat:malware', 'ext:geosite_IR.dat:phishing', 'ext:geosite_IR.dat:cryptominers'],
    ips: ['ext:geoip_IR.dat:malware', 'ext:geoip_IR.dat:phishing'],
  };
}

/** sing-box rule-set tags + URLs (SagerNet sing-geoip / sing-geosite). */
function singBoxCountryRuleSets(cc) {
  if (!/^[a-z]{2}$/.test(cc || '')) return null;
  const sets = [{ tag: `geoip-${cc}`, repo: 'sing-geoip', file: `geoip-${cc}.srs` }];
  if (GEOSITE[cc]) sets.push({ tag: `geosite-${GEOSITE[cc]}`, repo: 'sing-geosite', file: `geosite-${GEOSITE[cc]}.srs` });
  return { sets, suffix: `.${cc}` };
}

module.exports = { xrayCountryRules, securityBlockRules, singBoxCountryRuleSets, GEOSITE };
