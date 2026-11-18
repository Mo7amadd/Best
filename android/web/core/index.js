'use strict';
// Entry of the Android core bundle (globalThis.BestCore). Everything here is shared with the
// Windows app except android-xray.js.

const links = require('../../../src/core/links');
const subscription = require('../../../src/core/subscription');
const settings = require('../../../src/core/settings');
const util = require('../../../src/core/util');
const routing = require('../../../src/core/routing');
const xray = require('../../../src/core/xray-config');
const android = require('./android-xray');

module.exports = {
  links: {
    parseLink: links.parseLink,
    normalizeServer: links.normalizeServer,
    toLink: links.toLink,
    serverKey: links.serverKey,
    sameConnection: links.sameConnection,
    transportLabel: links.transportLabel,
    PROTOCOLS: links.PROTOCOLS,
  },
  subscription: {
    parseContent: subscription.parseContent,
    parseUserInfo: subscription.parseUserInfo,
    splitInfoNodes: subscription.splitInfoNodes,
  },
  settings: {
    DEFAULT_SETTINGS: settings.DEFAULT_SETTINGS,
    DEFAULT_ROUTING: settings.DEFAULT_ROUTING,
    sanitizeSettings: settings.sanitizeSettings,
    sanitizeRouting: settings.sanitizeRouting,
  },
  routing: { sanitizeRule: routing.sanitizeRule, effectiveRouting: routing.effectiveRouting },
  util: { cleanText: util.cleanText, randomId: util.randomId },
  xray: { needsSingBox: xray.needsSingBox, isUnencrypted: xray.isUnencrypted, needsLoopback: xray.needsLoopback },
  android: {
    buildConfig: android.buildAndroidConfig,
    buildDelayConfig: android.buildDelayConfig,
    buildSession: android.buildAndroidSession,
    buildTestConfig: android.buildTestConfig,
    serverNames: android.serverNamesOf,
    needsSingBox: android.needsSingBox,
  },
};
